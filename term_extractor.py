import json
import re

from prompts import build_term_extraction_prompt

# Suffix patterns from the spec (kept broad on purpose -- the LLM refine step
# narrows these down). A few extra suffixes (회장/위원/의원) are added because
# the spec's own examples (총학생회장, 대의원, 감사위원) don't match any listed
# pattern otherwise.
SUFFIX_PATTERNS = [
    "위원회", "학생회", "회칙", "세칙", "규정", "대표자회의", "선거",
    "위원장", "의장", "국장", "부장", "안건", "의결", "인준", "감사",
    "예산", "결산",
    "회장", "위원", "의원",
]

EXACT_TERMS = [
    "입후보", "선거운동본부", "정족수", "재적", "의결권", "표결",
    "발의", "상정", "가결", "부결",
]

_WORD_RE = re.compile(r"[가-힣]+")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?다니음됨])\s*\n+|(?<=[.!?])\s+")


def _split_sentences(text):
    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s.strip()]
    return sentences if sentences else [text.strip()]


def _sentence_for_position(text, start):
    sentences = _split_sentences(text)
    offset = 0
    for sentence in sentences:
        idx = text.find(sentence, offset)
        if idx == -1:
            idx = offset
        end = idx + len(sentence)
        if idx <= start < end:
            return sentence
        offset = end
    return sentences[0] if sentences else text.strip()


def rule_based_extract_terms(text):
    """Return a wide, over-inclusive list of {"ko_term", "context_sentence"}."""
    seen = {}
    for match in _WORD_RE.finditer(text):
        word = match.group(0)
        is_candidate = word in EXACT_TERMS or any(
            word.endswith(suffix) and len(word) > len(suffix) for suffix in SUFFIX_PATTERNS
        )
        if not is_candidate:
            continue
        if word not in seen:
            seen[word] = _sentence_for_position(text, match.start())

    return [{"ko_term": ko, "context_sentence": ctx} for ko, ctx in seen.items()]


def _coerce_priority(value):
    value = str(value).strip().lower()
    return value if value in ("high", "medium", "low") else "low"


def _extract_json_array(raw_text):
    raw_text = raw_text.strip()
    fence_match = re.search(r"```(?:json)?\s*(.*?)```", raw_text, re.DOTALL)
    if fence_match:
        raw_text = fence_match.group(1).strip()
    array_match = re.search(r"\[.*\]", raw_text, re.DOTALL)
    if array_match:
        raw_text = array_match.group(0)
    return json.loads(raw_text)


def llm_refine_terms(text, rule_candidates, generate_fn):
    """generate_fn(prompt) -> raw text response from the LLM."""
    ko_terms = [c["ko_term"] for c in rule_candidates]
    prompt = build_term_extraction_prompt(text, ko_terms)

    try:
        raw_response = generate_fn(prompt)
        items = _extract_json_array(raw_response)
    except Exception:
        return []

    refined = []
    for item in items:
        if not isinstance(item, dict) or not item.get("ko_term"):
            continue
        refined.append({
            "ko_term": str(item.get("ko_term", "")).strip(),
            "type": str(item.get("type", "General")).strip() or "General",
            "reason": str(item.get("reason", "")).strip(),
            "context_sentence": str(item.get("context_sentence", "")).strip(),
            "suggested_translation": str(item.get("suggested_translation", "")).strip(),
            "priority": _coerce_priority(item.get("priority", "low")),
        })
    return refined


def extract_candidate_terms(text, generate_fn):
    """Full pipeline: rule-based over-extraction -> LLM refine -> candidate_terms."""
    rule_candidates = rule_based_extract_terms(text)
    return llm_refine_terms(text, rule_candidates, generate_fn)
