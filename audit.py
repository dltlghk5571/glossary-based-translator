import re

import eval_metrics
from glossary_manager import match_terms, split_aliases
from prompts import build_repair_prompt

PLACEHOLDER_RE = re.compile(r"__TERM_\d+__")

_FORMAT_WARNING_LABELS = {
    "dates_preserved": "date(s)",
    "times_preserved": "time(s)",
    "numbers_preserved": "number(s)",
    "links_preserved": "URL(s)",
    "mentions_preserved": "@mention(s)",
    "hashtags_preserved": "#hashtag(s)",
}


def _format_warnings(raw_text, final_translation):
    """Non-blocking warnings (not violations) for dropped dates/times/numbers/
    URLs/mentions/hashtags -- reuses the same rule-based checks the evaluation
    pipeline scores against, so production and eval stay consistent."""
    checks = eval_metrics.format_checks(raw_text, final_translation)
    return [
        f"Possible {_FORMAT_WARNING_LABELS[key]} not preserved in translation."
        for key, ok in checks.items() if not ok
    ]


def audit_translation(raw_text, glossary_rows, placeholder_map, translation_draft, final_translation):
    """Rule-based glossary compliance audit.

    Returns {"has_violation": bool, "violations": [...]}.
    """
    violations = []

    # 1. required-term check: every ko_term/alias matched in the source must
    #    have its canonical en_term present in the final translation.
    required_matches = match_terms(raw_text, glossary_rows)
    seen_ko_terms = {}
    for match in required_matches:
        ko_term = match["ko_term"]
        en_term = match["en_term"]
        seen_ko_terms.setdefault(ko_term, en_term)
        if en_term not in final_translation:
            violations.append({
                "ko_term": ko_term,
                "required_en_term": en_term,
                "found": "",
                "issue": "Glossary term was not followed.",
            })

    # 2. forbidden_translations check, if that optional column is populated.
    for row in glossary_rows:
        forbidden_raw = row.get("forbidden_translations", "")
        if not forbidden_raw:
            continue
        for forbidden in split_aliases(forbidden_raw):
            if forbidden and forbidden in final_translation:
                violations.append({
                    "ko_term": row.get("ko_term", ""),
                    "required_en_term": row.get("en_term", ""),
                    "found": forbidden,
                    "issue": "Forbidden translation was used.",
                })

    # 3. leftover placeholder pattern in the final text.
    for leftover in set(PLACEHOLDER_RE.findall(final_translation)):
        violations.append({
            "ko_term": "",
            "required_en_term": "",
            "found": leftover,
            "issue": "Placeholder was left unresolved in the final translation.",
        })

    # 4. placeholder silently dropped (present in draft pre-restoration, but
    #    its canonical term never made it into the final text).
    for placeholder, en_term in placeholder_map.items():
        if placeholder in translation_draft and en_term not in final_translation:
            violations.append({
                "ko_term": "",
                "required_en_term": en_term,
                "found": "",
                "issue": f"Placeholder {placeholder} was dropped during translation.",
            })

    # 5. consistency check: same ko_term should not map to multiple distinct
    #    en_terms across the glossary/matches (would indicate ambiguous data).
    ko_term_to_en = {}
    for ko_term, en_term in seen_ko_terms.items():
        ko_term_to_en.setdefault(ko_term, set()).add(en_term)
    for ko_term, en_terms in ko_term_to_en.items():
        if len(en_terms) > 1:
            violations.append({
                "ko_term": ko_term,
                "required_en_term": " / ".join(sorted(en_terms)),
                "found": "",
                "issue": "Same Korean term maps to multiple different glossary translations.",
            })

    return {
        "has_violation": len(violations) > 0,
        "violations": violations,
        "format_warnings": _format_warnings(raw_text, final_translation),
    }


def repair_translation(generate_fn, raw_text, current_translation, violations):
    """Call the LLM to fix only the glossary-related parts of a bad translation."""
    prompt = build_repair_prompt(violations, raw_text, current_translation)
    try:
        return generate_fn(prompt).strip()
    except Exception:
        return current_translation
