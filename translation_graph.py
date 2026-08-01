from typing import TypedDict

from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import MemorySaver

import glossary_manager as gm
import term_extractor
import audit as audit_mod
from prompts import build_translation_prompt

MAX_REPAIRS = 2


class TranslationState(TypedDict, total=False):
    raw_text: str
    glossary_path: str
    interactive: bool
    glossary: list

    matched_terms: list
    candidate_terms: list
    missing_terms: list

    user_term_decisions: list
    glossary_conflicts: list
    pending_terms: list  # internal: high-priority terms still awaiting an answer
    current_term: dict  # internal: term the last interrupt() asked about
    raw_user_response: str  # internal: the single-line answer for current_term

    protected_text: str
    placeholder_map: dict

    translation_draft: str
    audit_report: dict
    final_translation: str

    warnings: list
    repair_count: int


def build_user_message(term):
    """One term at a time: the ko_term is already known, so we only need the
    English translation back -- no 'ko = en' parsing, no multi-line input."""
    suggested = term.get("suggested_translation", "")
    return "\n".join([
        f"'{term['ko_term']}'은(는) glossary에 없는 용어입니다.",
        f"- 유형: {term.get('type', 'General')}",
        f"- 등장 문맥: \"{term.get('context_sentence', '')}\"",
        f"- LLM 제안: {suggested}",
        "",
        "영어 번역만 입력하세요 (건너뛰려면 skip 입력):",
    ])


def make_nodes(generate_fns):
    """Build the graph's node functions.

    generate_fns is a dict {"term_extraction": fn, "translation": fn,
    "repair": fn}, each a generate(prompt) -> text callable (see
    llm_providers.build_generate_fns). Nodes that don't call an LLM work fine
    with generate_fns=None (e.g. for offline tests or graph visualization).
    """
    generate_fns = generate_fns or {}

    def load_glossary(state):
        glossary = gm.load_glossary(state["glossary_path"])
        return {"glossary": glossary}

    def migrate_glossary_if_needed(state):
        # gm.load_glossary() already migrates legacy schema in-place before
        # returning rows, so by the time this node runs there is nothing left
        # to do. Kept as an explicit graph stage to mirror the requested flow.
        return {}

    def extract_candidate_terms(state):
        candidates = term_extractor.extract_candidate_terms(
            state["raw_text"], generate_fns["term_extraction"]
        )
        return {"candidate_terms": candidates}

    def match_existing_glossary_terms(state):
        matches = gm.match_terms(state["raw_text"], state["glossary"])
        return {"matched_terms": matches}

    def detect_missing_terms(state):
        glossary = state["glossary"]
        missing = []
        seen_ko = set()
        for cand in state.get("candidate_terms", []):
            ko_term = cand.get("ko_term", "").strip()
            if not ko_term or ko_term in seen_ko:
                continue
            seen_ko.add(ko_term)

            if gm.find_glossary_entry(glossary, ko_term) is not None:
                continue
            is_alias = any(
                ko_term in gm.split_aliases(row.get("aliases", "")) for row in glossary
            )
            if is_alias:
                continue
            missing.append(cand)
        return {"missing_terms": missing}

    def request_user_translations(state):
        pending = state.get("pending_terms")
        if pending is None:
            pending = [t for t in state.get("missing_terms", []) if t.get("priority") == "high"]

        warnings = list(state.get("warnings", []))

        if not state.get("interactive", True):
            for t in pending:
                warnings.append(
                    f"[no-interactive] High-priority missing term left untranslated: {t['ko_term']}"
                )
            return {"pending_terms": [], "warnings": warnings}

        if not pending:
            return {"pending_terms": []}

        current = pending[0]
        user_response = interrupt(build_user_message(current))
        return {"pending_terms": pending, "current_term": current, "raw_user_response": user_response}

    def parse_user_translations(state):
        current = state.get("current_term")
        if current is None:
            return {}

        answer = (state.get("raw_user_response") or "").strip()
        warnings = list(state.get("warnings", []))
        decisions = list(state.get("user_term_decisions", []))

        if answer and answer.lower() != "skip":
            decisions.append({"ko_term": current["ko_term"], "en_term": answer, "aliases": ""})
        else:
            warnings.append(f"High-priority term left unanswered: {current['ko_term']}")

        remaining = [t for t in state.get("pending_terms", []) if t["ko_term"] != current["ko_term"]]
        return {"user_term_decisions": decisions, "warnings": warnings, "pending_terms": remaining}

    def update_glossary(state):
        updated, conflicts = gm.append_user_terms(
            state["glossary"], state.get("user_term_decisions", []), state.get("candidate_terms", [])
        )
        gm.save_glossary(state["glossary_path"], updated)
        warnings = list(state.get("warnings", []))
        for c in conflicts:
            warnings.append(
                f"Glossary conflict for '{c['ko_term']}': existing='{c['existing_en_term']}' "
                f"new='{c['new_en_term']}' (kept existing translation)"
            )
        return {"glossary": updated, "glossary_conflicts": conflicts, "warnings": warnings}

    def protect_glossary_terms(state):
        matches = gm.match_terms(state["raw_text"], state["glossary"])
        text = state["raw_text"]

        placeholder_map = {}
        pieces = []
        cursor = 0
        counter = 1
        for m in sorted(matches, key=lambda x: x["start"]):
            if m["start"] < cursor:
                continue
            placeholder = f"__TERM_{counter:03d}__"
            placeholder_map[placeholder] = m["en_term"]
            pieces.append(text[cursor:m["start"]])
            pieces.append(placeholder)
            cursor = m["end"]
            counter += 1
        pieces.append(text[cursor:])

        return {"protected_text": "".join(pieces), "placeholder_map": placeholder_map}

    def translate_text(state):
        prompt = build_translation_prompt(state["protected_text"])
        return {"translation_draft": generate_fns["translation"](prompt).strip()}

    def restore_placeholders(state):
        text = state["translation_draft"]
        for placeholder, en_term in state["placeholder_map"].items():
            text = text.replace(placeholder, en_term)
        return {"final_translation": text}

    def audit_translation(state):
        report = audit_mod.audit_translation(
            state["raw_text"],
            state["glossary"],
            state["placeholder_map"],
            state["translation_draft"],
            state["final_translation"],
        )
        return {"audit_report": report}

    def repair_translation(state):
        corrected = audit_mod.repair_translation(
            generate_fns["repair"],
            state["raw_text"],
            state["final_translation"],
            state["audit_report"]["violations"],
        )
        return {
            "final_translation": corrected,
            "repair_count": state.get("repair_count", 0) + 1,
        }

    def finalize_output(state):
        warnings = list(state.get("warnings", []))
        audit_report = state.get("audit_report", {})
        if audit_report.get("has_violation"):
            warnings.append(
                f"Glossary violations remained after {state.get('repair_count', 0)} repair attempt(s)."
            )
        warnings.extend(audit_report.get("format_warnings", []))
        return {"warnings": warnings}

    return {
        "load_glossary": load_glossary,
        "migrate_glossary_if_needed": migrate_glossary_if_needed,
        "extract_candidate_terms": extract_candidate_terms,
        "match_existing_glossary_terms": match_existing_glossary_terms,
        "detect_missing_terms": detect_missing_terms,
        "request_user_translations": request_user_translations,
        "parse_user_translations": parse_user_translations,
        "update_glossary": update_glossary,
        "protect_glossary_terms": protect_glossary_terms,
        "translate_text": translate_text,
        "restore_placeholders": restore_placeholders,
        "audit_translation": audit_translation,
        "repair_translation": repair_translation,
        "finalize_output": finalize_output,
    }


def _missing_terms_branch(state):
    return "request_user_translations" if state.get("missing_terms") else "protect_glossary_terms"


def _audit_branch(state):
    report = state.get("audit_report", {})
    if report.get("has_violation") and state.get("repair_count", 0) < MAX_REPAIRS:
        return "repair_translation"
    return "finalize_output"


def _term_answer_branch(state):
    return "request_user_translations" if state.get("pending_terms") else "update_glossary"


def build_graph(generate_fns=None):
    nodes = make_nodes(generate_fns)
    graph = StateGraph(TranslationState)
    for name, fn in nodes.items():
        graph.add_node(name, fn)

    graph.add_edge(START, "load_glossary")
    graph.add_edge("load_glossary", "migrate_glossary_if_needed")
    graph.add_edge("migrate_glossary_if_needed", "extract_candidate_terms")
    graph.add_edge("extract_candidate_terms", "match_existing_glossary_terms")
    graph.add_edge("match_existing_glossary_terms", "detect_missing_terms")

    graph.add_conditional_edges(
        "detect_missing_terms",
        _missing_terms_branch,
        {
            "request_user_translations": "request_user_translations",
            "protect_glossary_terms": "protect_glossary_terms",
        },
    )
    graph.add_edge("request_user_translations", "parse_user_translations")
    graph.add_conditional_edges(
        "parse_user_translations",
        _term_answer_branch,
        {
            "request_user_translations": "request_user_translations",
            "update_glossary": "update_glossary",
        },
    )
    graph.add_edge("update_glossary", "protect_glossary_terms")

    graph.add_edge("protect_glossary_terms", "translate_text")
    graph.add_edge("translate_text", "restore_placeholders")
    graph.add_edge("restore_placeholders", "audit_translation")

    graph.add_conditional_edges(
        "audit_translation",
        _audit_branch,
        {
            "repair_translation": "repair_translation",
            "finalize_output": "finalize_output",
        },
    )
    graph.add_edge("repair_translation", "audit_translation")
    graph.add_edge("finalize_output", END)

    return graph


def save_graph_png(path="translation_graph.png", generate_fns=None):
    """Render the compiled graph to a PNG for visual inspection.

    This is a generated artifact (see .gitignore) -- regenerate it with:
        python -c "from translation_graph import save_graph_png; save_graph_png()"
    """
    compiled = build_graph(generate_fns).compile()
    png_bytes = compiled.get_graph().draw_mermaid_png()
    with open(path, "wb") as f:
        f.write(png_bytes)
    return path


def run_pipeline(raw_text, glossary_path, generate_fns, interactive=True, thread_id="cli-session"):
    """Compile and run the graph, driving any interrupt()/Command(resume=...)
    round-trip through stdin. Returns the final state dict.
    """
    graph = build_graph(generate_fns)
    app = graph.compile(checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": thread_id}}

    initial_state = {
        "raw_text": raw_text,
        "glossary_path": glossary_path,
        "interactive": interactive,
        "warnings": [],
        "repair_count": 0,
    }

    result = app.invoke(initial_state, config=config)
    while "__interrupt__" in result:
        print("\n" + result["__interrupt__"][0].value)
        try:
            user_text = input("> ")
        except EOFError:
            user_text = ""
        result = app.invoke(Command(resume=user_text), config=config)

    return result
