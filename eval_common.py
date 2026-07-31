"""Shared rule-based helpers for eval_data case construction and evaluation.

Kept dependency-free (stdlib only) so both build_eval_data.py, evaluate.py,
and test_evaluation.py can import it without needing an API key.
"""
import re

HASHTAG_RE = re.compile(r"#[^\s#]+")
MENTION_RE = re.compile(r"@[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*")
URL_RE = re.compile(r"https?://[^\s)]+")
DATE_RE = re.compile(
    r"\d{4}[.\-]\d{1,2}[.\-]\d{1,2}"      # 2025.09.05 / 2025-09-05
    r"|\d{1,2}월\s?\d{1,2}일"              # 12월 15일
    r"|\d{1,2}/\d{1,2}"                    # 11/16
)
TIME_RE = re.compile(
    r"\d{1,2}:\d{2}"                       # 20:30
    r"|오전\s?\d{1,2}시|오후\s?\d{1,2}시"    # 오후 1시
    r"|\d{1,2}시"                          # 24시
)
NUMBER_RE = re.compile(r"\d+")


def _strip_trailing_punct(s):
    return s.rstrip(".,!?)，。")


def extract_hashtags(text):
    tags = []
    for m in HASHTAG_RE.finditer(text):
        tag = _strip_trailing_punct(m.group(0))
        core = tag[1:]
        if core and not core.isdigit():
            tags.append(tag)
    return tags


def extract_mentions(text):
    return [m.group(0) for m in MENTION_RE.finditer(text)]


def extract_urls(text):
    return [_strip_trailing_punct(m.group(0)) for m in URL_RE.finditer(text)]


def extract_dates(text):
    return [m.group(0) for m in DATE_RE.finditer(text)]


def extract_times(text):
    return [m.group(0) for m in TIME_RE.finditer(text)]


def extract_numbers(text):
    return [m.group(0) for m in NUMBER_RE.finditer(text)]


def hangul_ratio(text):
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    hangul = sum(1 for c in letters if "가" <= c <= "힣")
    return hangul / len(letters)


def is_korean_text(text):
    return hangul_ratio(text) > 0.3


# --- post_type / topic classification (rule-based, low-confidence -> "other") ---

POST_TYPE_KEYWORDS = [
    ("recruitment", ["모집"]),
    ("election", ["선거관리위원회", "선거시행세칙", "입후보", "총학생회장 선거"]),
    ("report", ["활동일지", "활동 보고", "결산 보고"]),
    ("statement", ["성명서", "입장문"]),
    ("event", ["이벤트", "행사 안내", "부스 운영", "축제"]),
    ("guide", ["설문조사", "이용 안내", "신청 방법"]),
]

TOPIC_KEYWORDS = [
    ("election", ["선거", "후보", "투표율", "개표"]),
    ("student_council", ["총학생회", "중앙운영위원회", "대의원", "전체학생대표자회의", "학생회"]),
    ("finance", ["예산", "결산", "회계", "지원금"]),
    ("academic", ["강의", "수업", "학점", "시험", "강의실", "콘센트", "커리큘럼"]),
    ("international", ["국제", "외국인", "international", "유학생"]),
    ("event", ["이벤트", "행사", "축제", "부스", "MT", "KAMF"]),
    ("welfare", ["카페", "복합기", "라운지", "휴게실", "셔틀버스", "생활관", "기숙사", "정류장"]),
    ("policy", ["제도 개선", "규정 개정", "정책"]),
]


def classify_post_type(text):
    for post_type, keywords in POST_TYPE_KEYWORDS:
        if any(k in text for k in keywords):
            return post_type, True
    if "안내" in text:
        return "notice", True
    return "other", False


def classify_topic(text):
    for topic, keywords in TOPIC_KEYWORDS:
        if any(k in text for k in keywords):
            return topic, True
    return "other", False


def assign_splits(case_ids):
    """case_ids: sorted list of case id strings. Returns {case_id: split}."""
    n = len(case_ids)
    if n <= 3:
        holdout_n = 0
    elif n <= 9:
        holdout_n = 2 if n >= 8 else 1
    else:
        holdout_n = round(n * 0.3)

    splits = {}
    holdout_ids = set(case_ids[n - holdout_n:]) if holdout_n else set()
    for cid in case_ids:
        splits[cid] = "holdout" if cid in holdout_ids else "optimization"
    return splits
