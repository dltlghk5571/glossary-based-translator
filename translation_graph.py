import re
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
    raw_user_response: str  # internal: unparsed multi-line answer

    protected_text: str
    placeholder_map: dict

    translation_draft: str
    audit_report: dict
    final_translation: str

    warnings: list
    repair_count: int


def build_user_message(high_priority_terms):
    lines = [
        "다음 용어들은 학생사회에서 고정 번역이 필요할 가능성이 높지만 glossary에 없습니다.",
        "각 용어의 공식 영어 번역을 입력해주세요.",
        "",
    ]
    for i, term in enumerate(high_priority_terms, 1):
        suggested = term.get("suggested_translation", "")
        lines.append(f"{i}. {term['ko_term']}")
        lines.append(f"- 유형: {term.get('type', 'General')}")
        lines.append(f"- 등장 문맥: \"{term.get('context_sentence', '')}\"")
        lines.append(f"- LLM 제안: {suggested}")
        lines.append(f"- 필요한 입력 예시: {term['ko_term']} = {suggested}")
        lines.append("")
    lines.append("입력 형식:")
    for term in high_priority_terms:
        lines.append(f"{term['ko_term']} = {term.get('suggested_translation', '')}")
    return "\n".join(lines)


_ANSWER_LINE_RE = re.compile(r"^(.+?)\s*(?:->|=|:)\s*(.+)$")


def parse_user_response(raw_text):
    """Parse the user's multi-line answer into
    [{"ko_term", "en_term", "aliases", "skipped"}]. Supports 'ko = en',
    'ko: en', 'ko -> en', and an optional trailing '| aliases: a, b'.
    """
    decisions = []
    for line in raw_text.splitlines():
        line = line.strip()
        if not line:
            continue

        main_part = line
        aliases = ""
        if "|" in line:
            main_part, alias_part = line.split("|", 1)
            alias_match = re.search(r"aliases\s*:\s*(.+)", alias_part, re.IGNORECASE)
            if alias_match:
                aliases = alias_match.group(1).strip()

        m = _ANSWER_LINE_RE.match(main_part.strip())
        if not m:
            continue

        ko_term = m.group(1).strip()
        en_term = m.group(2).strip()
        skipped = (not en_term) or en_term.lower() == "skip"
        decisions.append({
            "ko_term": ko_term,
            "en_term": "" if skipped else en_term,
            "aliases": aliases,
            "skipped": skipped,
        })
    return decisions


def _read_multiline_input():
    print("(입력을 마치려면 빈 줄을 입력하세요)")
    lines = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip() == "":
            break
        lines.append(line)
    return "\n".join(lines)


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
        missing = state.get("missing_terms", [])
        high_priority = [t for t in missing if t.get("priority") == "high"]
        warnings = list(state.get("warnings", []))

        if not state.get("interactive", True):
            for t in high_priority:
                warnings.append(
                    f"[no-interactive] High-priority missing term left untranslated: {t['ko_term']}"
                )
            return {"raw_user_response": "", "warnings": warnings}

        if not high_priority:
            return {"raw_user_response": ""}

        message = build_user_message(high_priority)
        user_response = interrupt(message)
        return {"raw_user_response": user_response}

    def parse_user_translations(state):
        raw = state.get("raw_user_response", "")
        parsed = parse_user_response(raw) if raw else []
        warnings = list(state.get("warnings", []))
        missing_by_ko = {t["ko_term"]: t for t in state.get("missing_terms", [])}

        decisions = []
        answered_ko = set()
        for item in parsed:
            answered_ko.add(item["ko_term"])
            if item["skipped"]:
                term = missing_by_ko.get(item["ko_term"])
                if term and term.get("priority") == "high":
                    warnings.append(f"High-priority term skipped by user: {item['ko_term']}")
                continue
            decisions.append({
                "ko_term": item["ko_term"],
                "en_term": item["en_term"],
                "aliases": item["aliases"],
            })

        if state.get("interactive", True):
            for t in missing_by_ko.values():
                if t.get("priority") == "high" and t["ko_term"] not in answered_ko:
                    warnings.append(f"High-priority term left unanswered: {t['ko_term']}")

        return {"user_term_decisions": decisions, "warnings": warnings}

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
    graph.add_edge("parse_user_translations", "update_glossary")
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
        print("\n" + result["__interrupt__"][0].value + "\n")
        user_text = _read_multiline_input()
        result = app.invoke(Command(resume=user_text), config=config)

    return result
