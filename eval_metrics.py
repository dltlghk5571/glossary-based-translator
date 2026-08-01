"""Rule-based (no API key needed) scoring of a single eval case.

Given the case's input/reference/prediction text plus the glossary and the
pipeline's own audit_report/missing_terms output, compute eval_report.json.
"""
import re

import eval_common as ec
import glossary_manager as gm
import term_extractor

ABBREVIATION_MAX_LEN = 3  # heuristic: short ko_term candidates read as likely aliases

MONTH_NAMES = {
    1: ("jan", "january"), 2: ("feb", "february"), 3: ("mar", "march"),
    4: ("apr", "april"), 5: ("may",), 6: ("jun", "june"),
    7: ("jul", "july"), 8: ("aug", "august"), 9: ("sep", "sept", "september"),
    10: ("oct", "october"), 11: ("nov", "november"), 12: ("dec", "december"),
}

_DATE_YMD_RE = re.compile(r"(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})")
_DATE_KO_RE = re.compile(r"(\d{1,2})월\s?(\d{1,2})일")
_DATE_SLASH_RE = re.compile(r"(\d{1,2})/(\d{1,2})")
_DATE_MONTH_ONLY_RE = re.compile(r"(\d{1,2})월(?!\s?\d{1,2}일)")

# Korean counter/ordinal/quantifier suffixes that are commonly translated as
# English words rather than digits (e.g. "1회" -> "once", "2주차" -> "second
# week", "1인당" -> "per person"). Numbers with these suffixes are excluded
# from strict numbers_preserved -- treating a stylistic word-form conversion
# as data loss would be a false positive.
_COUNTER_SUFFIXES = ("회", "번째", "주차", "차례", "인당", "학기")

# Comma-grouped numbers ("12,900") must be matched as one token, not split
# into "12" and "900" by a plain \d+ scan.
_COMMA_NUMBER_RE = re.compile(r"\d{1,3}(?:,\d{3})+|\d+")


def _digit_present(value, text):
    """Boundary-safe check: is this number present as its own token (not a
    substring of a larger number), in either plain or zero-padded form? Also
    accepts a 2-digit Korean year shorthand (e.g. '25') expanded to a
    4-digit year in translation ('2025')."""
    n = int(str(value).replace(",", ""))
    text = text.replace(",", "")  # "50,000" -> "50000" (thousands separator)
    for candidate in {str(n), f"{n:02d}"}:
        if re.search(rf"(?<!\d){candidate}(?!\d)", text):
            return True
    if 0 <= n <= 99:
        for m4 in re.finditer(r"\d{4,}", text):
            if m4.group(0)[-2:] == f"{n:02d}":
                return True
    return False


def _month_present(month_value, text):
    if _digit_present(month_value, text):
        return True
    names = MONTH_NAMES.get(int(month_value), ())
    low = text.lower()
    return any(name in low for name in names)


def _date_token_preserved(token, prediction):
    """A date is 'preserved' if its day is preserved as a number and its
    month is preserved either as a number or as an English month name --
    natural translation commonly renders '12월' as 'December', which is not
    a loss."""
    m = _DATE_YMD_RE.search(token)
    if m:
        _year, month, day = m.groups()
        return _digit_present(day, prediction) and _month_present(month, prediction)
    m = _DATE_KO_RE.search(token)
    if m:
        month, day = m.groups()
        return _digit_present(day, prediction) and _month_present(month, prediction)
    m = _DATE_SLASH_RE.search(token)
    if m:
        month, day = m.groups()
        return _digit_present(day, prediction) and _month_present(month, prediction)
    m = _DATE_MONTH_ONLY_RE.search(token)
    if m:
        return _month_present(m.group(1), prediction)
    return token in prediction


def _dates_preserved(dates, prediction):
    missing = [d for d in dates if not _date_token_preserved(d, prediction)]
    return len(missing) == 0, missing


def _numbers_preserved(numbers, prediction):
    missing = [n for n in numbers if not _digit_present(n, prediction)]
    return len(missing) == 0, missing


def extract_bare_month_dates(text):
    """Month mentions with no day part (e.g. '지난 9월'), which DATE_RE misses
    since it requires a day. Checked separately via month-name-aware logic."""
    return [m.group(0) for m in _DATE_MONTH_ONLY_RE.finditer(text)]


def _standalone_numbers(text):
    """All numbers in text that are not part of a date/time token (those are
    checked separately, with month-name-aware logic for dates), and not a
    Korean counter/ordinal ('1회', '2주차') that's naturally rendered as an
    English word rather than a digit."""
    exclude_spans = (
        [m.span() for m in ec.DATE_RE.finditer(text)]
        + [m.span() for m in ec.TIME_RE.finditer(text)]
        + [m.span() for m in _DATE_MONTH_ONLY_RE.finditer(text)]
    )
    numbers = []
    for m in _COMMA_NUMBER_RE.finditer(text):
        start, end = m.span()
        if any(start >= a and end <= b for a, b in exclude_spans):
            continue
        if text[end:end + 1] == "만":
            # Korean 10,000-won unit: "5만원" == 50,000 won; translations
            # commonly spell out the full amount instead of the bare digit.
            numbers.append(str(int(m.group(0).replace(",", "")) * 10000))
            continue
        if any(text[end:end + len(sfx)] == sfx for sfx in _COUNTER_SUFFIXES):
            continue
        numbers.append(m.group(0))
    return numbers


_TIME_HHMM_RE = re.compile(r"(\d{1,2}):(\d{2})")
_TIME_HOUR_ONLY_RE = re.compile(r"(\d{1,2})시")


def _hour_preserved(hour, prediction):
    """A bare hour is preserved if it appears as-is, as its 12h-clock form,
    or -- for the '24시'/'0시' midnight edge case -- as '12' (AM)."""
    hour12 = hour % 12 or 12
    if hour in (0, 24):
        return _digit_present(12, prediction)
    return _digit_present(hour, prediction) or _digit_present(hour12, prediction)


def _time_token_preserved(token, prediction):
    """A 24h 'HH:MM' or Korean 'NN시' time is preserved if the hour matches
    either as-is or converted to 12h clock (translation commonly renders
    '20:30' as '8:30 PM', or '24시' as midnight/'12 AM'), which is not a
    loss."""
    m = _TIME_HHMM_RE.match(token)
    if m:
        hour, minute = int(m.group(1)), int(m.group(2))
        return _hour_preserved(hour, prediction) and _digit_present(minute, prediction)

    m = _TIME_HOUR_ONLY_RE.match(token)
    if m:
        return _hour_preserved(int(m.group(1)), prediction)

    digits = ec.extract_numbers(token)
    return all(_digit_present(d, prediction) for d in digits) if digits else True


def _times_preserved(times, prediction):
    missing = [t for t in times if not _time_token_preserved(t, prediction)]
    return len(missing) == 0, missing


def _exact_preserved(tokens, prediction):
    missing = [t for t in tokens if t not in prediction]
    return len(missing) == 0, missing


def glossary_compliance(input_text, prediction_text, glossary_rows):
    matches = gm.match_terms(input_text, glossary_rows)
    required = {}
    for m in matches:
        required[m["ko_term"]] = m["en_term"]

    missing = [ko for ko, en in required.items() if en not in prediction_text]
    matched = len(required) - len(missing)
    score = 1.0 if not required else matched / len(required)
    return {
        "required_terms": len(required),
        "matched_terms": matched,
        "missing_required_terms": missing,
        "score": round(score, 4),
    }


def reference_term_overlap(input_text, reference_text, prediction_text, glossary_rows):
    """Of the *approved* glossary en_terms whose ko_term actually appears in
    the source and whose en_term appears in the reference, how many also
    appear in the prediction? A supplementary signal beyond source-side
    glossary compliance. Restricted to terms present in the source text --
    otherwise a generic single-word en_term (e.g. "program", "special") can
    coincidentally appear in the reference's prose with no connection to the
    glossary term at all, producing false failure signals."""
    source_ko_terms = {m["ko_term"] for m in gm.match_terms(input_text, glossary_rows)}
    present_in_ref = {
        row["en_term"] for row in glossary_rows
        if row.get("en_term") and row["en_term"] in reference_text
        and row.get("ko_term") in source_ko_terms
    }
    missing = sorted(t for t in present_in_ref if t not in prediction_text)
    matched = len(present_in_ref) - len(missing)
    score = 1.0 if not present_in_ref else matched / len(present_in_ref)
    return {
        "required_terms": len(present_in_ref),
        "matched_terms": matched,
        "missing_required_terms": missing,
        "score": round(score, 4),
    }


def missing_term_detection(input_text, candidate_terms, missing_terms):
    high_priority = [t["ko_term"] for t in missing_terms if t.get("priority") == "high"]
    return {
        "num_candidate_terms": len(candidate_terms),
        "num_missing_terms": len(missing_terms),
        "high_priority_missing_terms": high_priority,
    }


def format_checks(input_text, prediction_text):
    dates = ec.extract_dates(input_text) + extract_bare_month_dates(input_text)
    dates_ok, _ = _dates_preserved(dates, prediction_text)
    times_ok, _ = _times_preserved(ec.extract_times(input_text), prediction_text)
    numbers_ok, _ = _numbers_preserved(_standalone_numbers(input_text), prediction_text)
    links_ok, _ = _exact_preserved(ec.extract_urls(input_text), prediction_text)
    mentions_ok, _ = _exact_preserved(ec.extract_mentions(input_text), prediction_text)
    hashtags_ok, _ = _exact_preserved(ec.extract_hashtags(input_text), prediction_text)
    return {
        "dates_preserved": dates_ok,
        "times_preserved": times_ok,
        "numbers_preserved": numbers_ok,
        "links_preserved": links_ok,
        "mentions_preserved": mentions_ok,
        "hashtags_preserved": hashtags_ok,
    }


def _term_extraction_false_negatives(input_text, candidate_terms):
    rule_ko_terms = {c["ko_term"] for c in term_extractor.rule_based_extract_terms(input_text)}
    refined_ko_terms = {c["ko_term"] for c in candidate_terms}
    return sorted(rule_ko_terms - refined_ko_terms)


def _term_extraction_false_positives(input_text, candidate_terms):
    """A refined candidate whose ko_term doesn't even appear in the source
    text is hallucinated, not extracted."""
    return sorted({
        c["ko_term"] for c in candidate_terms
        if c.get("ko_term") and c["ko_term"] not in input_text
    })


def classify_failures(input_text, prediction_text, glossary_comp, ref_overlap,
                       fmt_checks, missing_terms, candidate_terms, metadata, warnings):
    categories = set()

    if glossary_comp["missing_required_terms"]:
        categories.add("glossary_missing")
        if any(len(t) <= ABBREVIATION_MAX_LEN for t in glossary_comp["missing_required_terms"]):
            categories.add("alias_missing")

    high_priority_missing = [t for t in missing_terms if t.get("priority") == "high"]
    if high_priority_missing:
        categories.add("glossary_missing")
        if any(len(t.get("ko_term", "")) <= ABBREVIATION_MAX_LEN for t in high_priority_missing):
            categories.add("alias_missing")

    if _term_extraction_false_negatives(input_text, candidate_terms):
        categories.add("term_extraction_false_negative")
    if _term_extraction_false_positives(input_text, candidate_terms):
        categories.add("term_extraction_false_positive")

    if not all(fmt_checks.values()):
        categories.add("format_loss")
    if not fmt_checks["dates_preserved"] or not fmt_checks["numbers_preserved"] or not fmt_checks["times_preserved"]:
        categories.add("date_or_number_loss")

    if ref_overlap["required_terms"] and ref_overlap["score"] < 0.5:
        categories.add("reference_semantic_gap")

    if not prediction_text.strip() or prediction_text.strip().lower().startswith("error:"):
        categories.add("llm_api_failure")

    if metadata.get("manual_review_required"):
        categories.add("manual_review_required")

    if any("no-interactive" in w or "left untranslated" in w or "left unanswered" in w for w in warnings):
        categories.add("glossary_missing")

    return sorted(categories)


def evaluate_case(case_id, split, input_text, reference_text, prediction_text,
                   glossary_rows, candidate_terms, missing_terms, metadata,
                   pipeline_warnings=None):
    pipeline_warnings = pipeline_warnings or []

    glossary_comp = glossary_compliance(input_text, prediction_text, glossary_rows)
    ref_overlap = reference_term_overlap(input_text, reference_text, prediction_text, glossary_rows)
    missing_det = missing_term_detection(input_text, candidate_terms, missing_terms)
    fmt_checks = format_checks(input_text, prediction_text)
    length_ratio = round(len(prediction_text) / len(reference_text), 4) if reference_text else 0.0

    failure_categories = classify_failures(
        input_text, prediction_text, glossary_comp, ref_overlap, fmt_checks,
        missing_terms, candidate_terms, metadata, pipeline_warnings,
    )

    warnings = list(pipeline_warnings)
    if glossary_comp["missing_required_terms"]:
        warnings.append(f"Missing required glossary terms: {glossary_comp['missing_required_terms']}")
    for key, ok in fmt_checks.items():
        if not ok:
            warnings.append(f"Format check failed: {key}")

    return {
        "case_id": case_id,
        "split": split,
        "glossary_compliance": glossary_comp,
        "reference_term_overlap": ref_overlap,
        "missing_term_detection": missing_det,
        "format_checks": fmt_checks,
        "length_ratio": length_ratio,
        "failure_categories": failure_categories,
        "manual_review_required": bool(metadata.get("manual_review_required")) or "manual_review_required" in failure_categories,
        "warnings": warnings,
    }
