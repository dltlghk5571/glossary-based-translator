"""Functional web API for the backoffice's /api/analyze and /api/translate --
explicit steps instead of the CLI's interrupt()-driven human-in-the-loop.

Reuses the same pure logic as translation_graph.py's node closures
(term_extractor, glossary_manager, audit, prompts) but reads the glossary from
Postgres (db_glossary.py) instead of glossary.csv, since Vercel's filesystem
is read-only at runtime. Glossary CRUD itself (create/update/export) lives in
the Next.js app via Prisma -- see app/api/glossary/**.
"""
import glossary_manager as gm
import term_extractor
import audit as audit_mod
import db_glossary
from prompts import build_translation_prompt
from llm_providers import build_generate_fns

MAX_REPAIRS = 2


def _detect_missing_terms(candidate_terms, glossary):
    missing = []
    seen_ko = set()
    for cand in candidate_terms:
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
    return missing


def _protect_glossary_terms(text, glossary):
    matches = gm.match_terms(text, glossary)
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
    return "".join(pieces), placeholder_map, matches


def analyze_text(text):
    """Step 1: extract candidate terms, match against the glossary, surface
    missing ones for the user to fill in and approve (POST /api/glossary/approve)."""
    glossary = db_glossary.fetch_glossary_rows()
    generate_fns = build_generate_fns()

    candidate_terms = term_extractor.extract_candidate_terms(text, generate_fns["term_extraction"])
    matched_terms = gm.match_terms(text, glossary)
    missing_terms = _detect_missing_terms(candidate_terms, glossary)

    return {
        "candidate_terms": candidate_terms,
        "matched_terms": matched_terms,
        "missing_terms": missing_terms,
        "warnings": [],
    }


def translate_text(text):
    """Step 2: protect glossary terms, translate, restore, audit, repair --
    same sequence as translation_graph.py's post-glossary-update nodes."""
    glossary = db_glossary.fetch_glossary_rows()
    generate_fns = build_generate_fns()

    protected_text, placeholder_map, _matches = _protect_glossary_terms(text, glossary)
    translation_draft = generate_fns["translation"](build_translation_prompt(protected_text)).strip()

    final_translation = translation_draft
    for placeholder, en_term in placeholder_map.items():
        final_translation = final_translation.replace(placeholder, en_term)

    audit_report = audit_mod.audit_translation(text, glossary, placeholder_map, translation_draft, final_translation)

    repair_count = 0
    while audit_report["has_violation"] and repair_count < MAX_REPAIRS:
        final_translation = audit_mod.repair_translation(
            generate_fns["repair"], text, final_translation, audit_report["violations"]
        )
        repair_count += 1
        audit_report = audit_mod.audit_translation(text, glossary, placeholder_map, translation_draft, final_translation)

    warnings = []
    if audit_report.get("has_violation"):
        warnings.append(f"Glossary violations remained after {repair_count} repair attempt(s).")
    warnings.extend(audit_report.get("format_warnings", []))

    return {
        "translation": final_translation,
        "audit_report": audit_report,
        "warnings": warnings,
    }
