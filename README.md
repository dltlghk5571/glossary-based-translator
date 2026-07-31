# KAIST_UA Translator

LangGraph Human-in-the-Loop Glossary Translation System

## Overview

A Korean → English translation pipeline for student-society (학생사회) documents that keeps
institutional terminology consistent by controlling it through a glossary, instead of letting
the LLM decide fixed translations on its own.

Core features:
- Glossary-driven Korean → English translation
- Automatic detection of student-society terms that likely need a fixed translation
- User confirmation for any high-priority term missing from the glossary
- User-provided translations are automatically appended to the glossary
- Placeholder-based protection of glossary terms during translation
- Post-translation glossary compliance audit
- Bounded repair loop (max 2 attempts) when the audit finds violations
- Legacy translator still available via `--legacy`

## Setup

Python 3.12 is recommended. The system Python on this machine was 3.14, where `pydantic`/
`langchain-core` (a `langgraph` dependency) fail to import — a real upstream incompatibility
with that Python version, not something fixable in this project. Use a Python 3.12 virtual
environment instead:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## API key

This project supports three LLM providers — Anthropic, Google (Gemini), and OpenAI — each read
only from the environment; there is no hardcoded key in the source. See `.env.example` for the
expected variable names.

```bash
export ANTHROPIC_API_KEY="your_anthropic_api_key_here"
export GOOGLE_API_KEY="your_google_api_key_here"      # only needed for --legacy or google-provider steps
export OPENAI_API_KEY="your_openai_api_key_here"       # only needed for openai-provider steps
```

**Provider selection.** The pipeline has three LLM-backed steps — term extraction, translation,
and glossary repair (`llm_providers.py`) — and each defaults to **Anthropic (`claude-sonnet-5`)**:
it gives reliable structured JSON for term extraction and strict instruction adherence for
translation/repair (glossary terms and `__TERM_NNN__` placeholders must come back byte-for-byte
unchanged, never paraphrased), at roughly 40% of Opus-tier cost — plenty of quality headroom for
this task. A key is only required for the provider actually selected for each step — the CLI
exits with a clear error naming the missing variable if you select a provider whose key isn't
set. Override the model within a provider via `ANTHROPIC_MODEL` / `OPENAI_MODEL` / `GOOGLE_MODEL`
(e.g. `ANTHROPIC_MODEL=claude-opus-4-8` for maximum quality, or `claude-haiku-4-5` for lowest cost).

Override any step independently:

```bash
export TRANSLATION_PROVIDER=openai      # anthropic (default) | openai | google
export TERM_EXTRACTION_PROVIDER=google
export REPAIR_PROVIDER=anthropic
```

`--legacy` mode is unaffected by all of this — it always uses `GOOGLE_API_KEY` directly (the
original Gemini-only pipeline).

## Usage

Basic run:

```bash
python translator.py --input input.txt --output output.txt --glossary glossary.csv --interactive
```

Dry run (only extract candidate/missing terms, no translation, no LLM call needed for the
translation step):

```bash
python translator.py --input input.txt --glossary glossary.csv --dry-run
```

Non-interactive (never prompt; warnings are logged instead):

```bash
python translator.py --input input.txt --output output.txt --glossary glossary.csv --no-interactive
```

Save missing-term review list and audit report:

```bash
python translator.py --input input.txt --output output.txt --glossary glossary.csv \
  --interactive --review-missing missing_terms.json --save-audit audit_report.json
```

Legacy mode (original simple glossary-substring pipeline):

```bash
python translator.py --legacy
```

## Graph visualization

```bash
python -c "from translation_graph import build_graph; print(build_graph().compile().get_graph().draw_mermaid())"
python -c "from translation_graph import save_graph_png; save_graph_png()"
```

`translation_graph.png` is a generated artifact and is not committed.

## Glossary schema

`glossary.csv` columns:

- `ko_term` — the Korean term
- `en_term` — the approved English translation
- `type` — Organization / Regulation / Role-Position / Election / Finance /
  Meeting-Procedure / Academic / General
- `aliases` — comma-separated alternate Korean surface forms (e.g. abbreviations)
- `usage_note` — auto-generated guidance on how to use the translation
- `status` — only `approved` rows are ever force-matched/required during translation and
  evaluation (`glossary_manager.match_terms`). `deprecated` marks a row that should no longer be
  used (e.g. a legacy import that was fragment-misaligned and forces a wrong translation) without
  deleting its history. `pending_reference` marks a translation inferred from repeated
  correspondence in human-translated reference captions, not yet officially approved — it's
  tracked for review but not forced into output.
- `source` — `imported` (from legacy migration), `user` (typed in during a translation run), or
  `reference_inferred` (inferred from `eval_data` reference captions, see below).
- `last_context` — the sentence the term was first seen in, for reference

A legacy `Korean,English` glossary is migrated to this schema automatically on load; a
`.csv.bak` backup of the original file is written first, and no rows are dropped.

## Evaluation

`eval_data/cases/NNN/{input.txt, reference.txt, metadata.json}` holds human-translated
Instagram-caption test cases built from the raw `sample_instagram_korean/english` folders (see
`build_eval_data.py`). Cases are split into `optimization` (used to drive improvements) and
`holdout` (used only for final, one-shot validation — never viewed or tuned against directly).

Run the pipeline over the cases and score the output with rule-based (no-API-key-needed)
metrics — glossary compliance, reference-term overlap, date/time/number/URL/mention/hashtag
preservation, and automatic failure-category classification:

```bash
python evaluate.py --cases eval_data/cases --glossary glossary.csv --out eval_data/results \
  --no-interactive --split optimization --summary eval_data/eval_summary.json
```

Each case writes `eval_data/results/NNN/{prediction.txt, audit_report.json, missing_terms.json,
eval_report.json}`; `eval_data/eval_summary.json`/`.md` aggregate across all evaluated cases.
Actually calling the LLM still needs an API key; only the *scoring* layer (`eval_metrics.py`,
`eval_common.py`) is API-key-free.

## Tests

```bash
python -m unittest test_translation_system test_evaluation -v
```

## Notes

- `.venv` is not committed.
- `output.txt`, `audit_report.json`, `missing_terms.json` are generated files and are not
  committed.
- `glossary.csv` schema may change after migration from a legacy `Korean,English` file.
- `glossary.csv.bak` is a local backup and is not committed.
- `eval_data/results/`, `eval_data/eval_summary*.json`, `eval_data/eval_summary*.md` are
  regenerated by `evaluate.py` and are not committed.
