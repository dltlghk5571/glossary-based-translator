import os
import re
import shutil
import pandas as pd

from classify_glossary import classify_term

REQUIRED_COLUMNS = [
    "ko_term", "en_term", "type", "aliases",
    "usage_note", "status", "source", "last_context",
]

OPTIONAL_COLUMNS = [
    "forbidden_translations", "created_at", "updated_at",
    "confidence", "review_count", "deprecated", "replacement_term",
]

TYPE_USAGE_NOTES = {
    "Organization": "Use as the official name of a student society organization.",
    "Regulation": "Use as the official title of a student society regulation or bylaw.",
    "Role/Position": "Use as the official title of a student society role or position.",
    "Election": "Use as an official student society election term.",
    "Finance": "Use as an official student society finance or accounting term.",
    "Meeting/Procedure": "Use as an official student society meeting or decision-making term.",
    "Academic": "Use as the official student society academic term.",
    "General": "Use exactly as the approved glossary translation.",
}


def _default_usage_note(term_type):
    return TYPE_USAGE_NOTES.get(term_type, TYPE_USAGE_NOTES["General"])


def _strip_type_label(label):
    """'Organization (기구/단체)' -> 'Organization'."""
    return label.split("(")[0].strip()


def _is_legacy_schema(columns):
    cols = set(columns)
    if set(REQUIRED_COLUMNS).issubset(cols):
        return False
    legacy_pairs = [
        {"Korean", "English"},
        {"ko", "en"},
    ]
    return any(pair.issubset(cols) for pair in legacy_pairs)


def migrate_glossary(path):
    """Upgrade a legacy ko/en glossary.csv to the full schema in place.

    No-op if the file is already in the new schema or doesn't exist.
    Writes a .bak backup of the original file before overwriting.
    """
    if not os.path.exists(path):
        return False

    df = pd.read_csv(path, dtype=str, keep_default_na=False)

    if not _is_legacy_schema(df.columns):
        return False

    if "Korean" in df.columns and "English" in df.columns:
        ko_col, en_col = "Korean", "English"
    else:
        ko_col, en_col = "ko", "en"

    rows = []
    for _, row in df.iterrows():
        ko = str(row[ko_col]).strip()
        en = str(row[en_col]).strip()
        if not ko:
            continue
        term_type = _strip_type_label(classify_term({"Korean": ko, "English": en}))
        rows.append({
            "ko_term": ko,
            "en_term": en,
            "type": term_type,
            "aliases": "",
            "usage_note": _default_usage_note(term_type),
            "status": "approved",
            "source": "imported",
            "last_context": "",
        })

    new_df = pd.DataFrame(rows, columns=REQUIRED_COLUMNS)

    backup_path = path + ".bak"
    shutil.copyfile(path, backup_path)
    new_df.to_csv(path, index=False, encoding="utf-8")
    return True


def load_glossary(path):
    """Load glossary.csv as a list of dicts, migrating legacy schema first."""
    if not os.path.exists(path):
        return []

    migrate_glossary(path)

    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    for col in REQUIRED_COLUMNS:
        if col not in df.columns:
            df[col] = ""

    return df.to_dict(orient="records")


def save_glossary(path, glossary_rows):
    if not glossary_rows:
        columns = REQUIRED_COLUMNS
    else:
        columns = list(glossary_rows[0].keys())
        for col in REQUIRED_COLUMNS:
            if col not in columns:
                columns.append(col)

    df = pd.DataFrame(glossary_rows, columns=columns)
    df = df.fillna("")
    df.to_csv(path, index=False, encoding="utf-8")


def split_aliases(aliases_str):
    if not aliases_str:
        return []
    return [a.strip() for a in re.split(r"[,\|]", aliases_str) if a.strip()]


def detect_conflicts(glossary_rows):
    """Find any ko_term/alias string that resolves to more than one en_term."""
    surface_to_terms = {}
    for row in glossary_rows:
        ko_term = row.get("ko_term", "").strip()
        en_term = row.get("en_term", "").strip()
        if not ko_term:
            continue
        surfaces = [ko_term] + split_aliases(row.get("aliases", ""))
        for surface in surfaces:
            surface_to_terms.setdefault(surface, set()).add((ko_term, en_term))

    conflicts = []
    for surface, term_set in surface_to_terms.items():
        distinct_en = {en for _, en in term_set}
        if len(distinct_en) > 1:
            conflicts.append({
                "surface": surface,
                "candidates": sorted(term_set),
            })
    return conflicts


def match_terms(text, glossary_rows):
    """Find glossary terms (by ko_term or alias) appearing in text.

    Longest surface form wins at each position. Returns matches in order of
    first appearance:
    [{"ko_term": ..., "en_term": ..., "matched_text": ..., "start": ..., "end": ..., "matched_via": "ko_term"|"alias"}]
    """
    surface_map = {}
    for row in glossary_rows:
        ko_term = row.get("ko_term", "").strip()
        en_term = row.get("en_term", "").strip()
        if not ko_term or not en_term:
            continue
        if row.get("status", "approved").strip() != "approved":
            continue
        if ko_term not in surface_map:
            surface_map[ko_term] = (ko_term, en_term, "ko_term")
        for alias in split_aliases(row.get("aliases", "")):
            if alias not in surface_map:
                surface_map[alias] = (ko_term, en_term, "alias")

    if not surface_map:
        return []

    surfaces = sorted(surface_map.keys(), key=len, reverse=True)
    pattern = "|".join(re.escape(s) for s in surfaces)
    regex = re.compile(pattern)

    matches = []
    for m in regex.finditer(text):
        matched_text = m.group(0)
        ko_term, en_term, matched_via = surface_map[matched_text]
        matches.append({
            "ko_term": ko_term,
            "en_term": en_term,
            "matched_text": matched_text,
            "start": m.start(),
            "end": m.end(),
            "matched_via": matched_via,
        })
    return matches


def find_glossary_entry(glossary_rows, ko_term):
    for row in glossary_rows:
        if row.get("ko_term", "").strip() == ko_term:
            return row
    return None


def append_user_terms(glossary_rows, user_decisions, candidate_terms):
    """Add user-approved translations to the glossary.

    Returns (updated_glossary_rows, conflicts) where conflicts is a list of
    dicts describing ko_term collisions with a different existing en_term.
    Existing entries are never overwritten (MVP behavior).
    """
    candidate_by_ko = {c.get("ko_term", "").strip(): c for c in candidate_terms}
    conflicts = []
    updated = list(glossary_rows)

    for decision in user_decisions:
        ko_term = decision.get("ko_term", "").strip()
        en_term = decision.get("en_term", "").strip()
        aliases = decision.get("aliases", "").strip()
        if not ko_term or not en_term:
            continue

        existing = find_glossary_entry(updated, ko_term)
        if existing is not None:
            if existing.get("en_term", "").strip() == en_term:
                continue
            conflicts.append({
                "ko_term": ko_term,
                "existing_en_term": existing.get("en_term", ""),
                "new_en_term": en_term,
            })
            continue

        candidate = candidate_by_ko.get(ko_term, {})
        term_type = candidate.get("type", "General")
        updated.append({
            "ko_term": ko_term,
            "en_term": en_term,
            "type": term_type,
            "aliases": aliases,
            "usage_note": _default_usage_note(term_type),
            "status": "approved",
            "source": "user",
            "last_context": candidate.get("context_sentence", ""),
        })

    return updated, conflicts
