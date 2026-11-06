"""Read-only glossary access for the web backoffice's analyze/translate endpoints.

Glossary CRUD (create/update/export) now lives in the Next.js app (lib/prisma.ts,
app/api/glossary/**) via Prisma -- Prisma's migrations are the single source of
truth for the "Glossary" table's schema. This module only reads that same table
with raw SQL, aliased back to glossary_manager.REQUIRED_COLUMNS shape so it drops
straight into gm.match_terms() / gm.find_glossary_entry() unchanged.
"""
from db import get_connection

_SELECT_COLUMNS = """
    id,
    korean AS ko_term,
    english AS en_term,
    type,
    aliases,
    "usageNote" AS usage_note,
    status,
    source,
    "lastContext" AS last_context
"""


def fetch_glossary_rows():
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(f'SELECT {_SELECT_COLUMNS} FROM "Glossary" ORDER BY korean')
            return cur.fetchall()


def fetch_pending_suggestion_koreans():
    """Korean terms with a pending GlossarySuggestion (Next.js 제안함). The
    analyzer treats these as not missing so users aren't asked again while a
    reviewer hasn't decided yet."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT DISTINCT korean FROM "GlossarySuggestion" WHERE status = %s', ("pending",))
            return {row["korean"] for row in cur.fetchall()}
