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

This project calls the Gemini API and reads the key only from the environment — there is no
hardcoded key in the source.

```bash
export GOOGLE_API_KEY="your_google_api_key_here"
```

See `.env.example` for the expected variable name. If `GOOGLE_API_KEY` is not set, the CLI
exits immediately with an error explaining how to set it.

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
- `status` — `approved` (only user-approved or migrated-imported terms are ever written here)
- `source` — `imported` (from legacy migration) or `user` (typed in during a translation run)
- `last_context` — the sentence the term was first seen in, for reference

A legacy `Korean,English` glossary is migrated to this schema automatically on load; a
`.csv.bak` backup of the original file is written first, and no rows are dropped.

## Tests

```bash
python -m unittest test_translation_system -v
```

## Notes

- `.venv` is not committed.
- `output.txt`, `audit_report.json`, `missing_terms.json` are generated files and are not
  committed.
- `glossary.csv` schema may change after migration from a legacy `Korean,English` file.
- `glossary.csv.bak` is a local backup and is not committed.
