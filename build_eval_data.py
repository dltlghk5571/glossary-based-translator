"""One-shot converter: sample_instagram_korean/english raw posts -> eval_data/
case structure (input.txt / reference.txt / metadata.json).

Usage:
    python build_eval_data.py

Idempotent: safe to re-run; it always rebuilds eval_data/raw and eval_data/cases
from the untouched sample_instagram_* originals.
"""
import csv
import json
import os
import shutil

import eval_common as ec

ROOT = os.path.dirname(os.path.abspath(__file__))
KO_DIR = os.path.join(ROOT, "sample_instagram_korean")
EN_DIR = os.path.join(ROOT, "sample_instagram_english")
EVAL_DIR = os.path.join(ROOT, "eval_data")
RAW_DIR = os.path.join(EVAL_DIR, "raw")
CASES_DIR = os.path.join(EVAL_DIR, "cases")

SOURCE_KO = "kaistua_grit"
SOURCE_EN = "kaistua_global"


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()


def copy_raw():
    for name, src in [("sample_instagram_korean", KO_DIR), ("sample_instagram_english", EN_DIR)]:
        dst = os.path.join(RAW_DIR, name)
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.copytree(src, dst)


def discover_pairs():
    """Return sorted list of (index, ko_path, en_path) by numeric suffix."""
    ko_files = {f: int("".join(c for c in f if c.isdigit())) for f in os.listdir(KO_DIR) if f.endswith(".txt")}
    en_files = {f: int("".join(c for c in f if c.isdigit())) for f in os.listdir(EN_DIR) if f.endswith(".txt")}
    ko_by_idx = {v: k for k, v in ko_files.items()}
    en_by_idx = {v: k for k, v in en_files.items()}
    indices = sorted(set(ko_by_idx) & set(en_by_idx))
    return [(i, os.path.join(KO_DIR, ko_by_idx[i]), os.path.join(EN_DIR, en_by_idx[i])) for i in indices]


def resolve_pair(ko_path, en_path):
    """Return (ko_text, en_text, ko_source_rel, en_source_rel, swapped)."""
    ko_text = _read(ko_path)
    en_text = _read(en_path)

    ko_is_korean = ec.is_korean_text(ko_text)
    en_is_korean = ec.is_korean_text(en_text)

    if ko_is_korean and not en_is_korean:
        return ko_text, en_text, ko_path, en_path, False
    if en_is_korean and not ko_is_korean:
        # The two source folders are swapped for this pair.
        return en_text, ko_text, en_path, ko_path, True
    # Ambiguous (both/neither look Korean) -- keep filename-based pairing,
    # flag for manual review via the caller.
    return ko_text, en_text, ko_path, en_path, None


def build_metadata(case_id, ko_text, en_text, ko_src_rel, en_src_rel, swapped, split):
    post_type, post_type_conf = ec.classify_post_type(ko_text)
    topic, topic_conf = ec.classify_topic(ko_text)

    hashtags = ec.extract_hashtags(ko_text)
    mentions = ec.extract_mentions(ko_text)
    urls = ec.extract_urls(ko_text)
    dates = ec.extract_dates(ko_text)
    times = ec.extract_times(ko_text)
    numbers = ec.extract_numbers(ko_text)

    notes = []
    manual_review = False
    if swapped:
        notes.append(
            "Source folders were swapped for this pair: the Korean text was found in the "
            "sample_instagram_english folder and vice versa. Auto-corrected by language "
            "detection; please confirm."
        )
        manual_review = True
    if swapped is None:
        notes.append("Could not confidently detect language of one or both sources; paired by filename only.")
        manual_review = True
    if not post_type_conf or not topic_conf:
        notes.append("post_type/topic assigned with low confidence.")
        manual_review = True

    return {
        "id": case_id,
        "source_ko": SOURCE_KO,
        "source_en": SOURCE_EN,
        "original_korean_file": os.path.relpath(ko_src_rel, ROOT),
        "original_english_file": os.path.relpath(en_src_rel, ROOT),
        "post_type": post_type,
        "topic": topic,
        "split": split,
        "language_pair": "ko-en",
        "has_hashtags": bool(hashtags),
        "has_mentions": bool(mentions),
        "has_urls": bool(urls),
        "hashtags": hashtags,
        "mentions": mentions,
        "urls": urls,
        "dates": dates,
        "times": times,
        "numbers": numbers,
        "char_count_ko": len(ko_text),
        "char_count_en": len(en_text),
        "line_count_ko": len(ko_text.splitlines()),
        "line_count_en": len(en_text.splitlines()),
        "manual_review_required": manual_review,
        "notes": " ".join(notes),
    }


def main():
    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(CASES_DIR, exist_ok=True)
    copy_raw()

    pairs = discover_pairs()
    case_ids = [f"{i:03d}" for i, _, _ in pairs]
    splits = ec.assign_splits(case_ids)

    review_rows = []
    for i, ko_path, en_path in pairs:
        case_id = f"{i:03d}"
        ko_text, en_text, ko_src, en_src, swapped = resolve_pair(ko_path, en_path)
        split = splits[case_id]

        case_dir = os.path.join(CASES_DIR, case_id)
        os.makedirs(case_dir, exist_ok=True)
        with open(os.path.join(case_dir, "input.txt"), "w", encoding="utf-8") as f:
            f.write(ko_text)
        with open(os.path.join(case_dir, "reference.txt"), "w", encoding="utf-8") as f:
            f.write(en_text)

        metadata = build_metadata(case_id, ko_text, en_text, ko_src, en_src, swapped, split)
        with open(os.path.join(case_dir, "metadata.json"), "w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)

        review_rows.append({
            "case_id": case_id,
            "korean_source": os.path.relpath(ko_src, ROOT),
            "english_source": os.path.relpath(en_src, ROOT),
            "detected_title_ko": ko_text.splitlines()[0] if ko_text else "",
            "detected_title_en": en_text.splitlines()[0] if en_text else "",
            "confidence": "corrected" if swapped else ("low" if swapped is None else "high"),
            "manual_review_required": metadata["manual_review_required"],
            "notes": metadata["notes"],
        })

    review_path = os.path.join(EVAL_DIR, "pairing_review.csv")
    with open(review_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "case_id", "korean_source", "english_source", "detected_title_ko",
            "detected_title_en", "confidence", "manual_review_required", "notes",
        ])
        writer.writeheader()
        writer.writerows(review_rows)

    print(f"Built {len(pairs)} cases under {CASES_DIR}")
    print(f"Split distribution: {sorted(splits.items())}")
    print(f"Pairing review written to {review_path}")


if __name__ == "__main__":
    main()
