"""Write-side access to the Prisma-managed "Translation" table for the web
backoffice's audit trail: what was translated, by whom, what warnings/terms
came up, and how many tokens it cost. Read-only equivalent for glossary is
db_glossary.py; the schema source of truth is prisma/migrations/.
"""
import json

from db import get_connection


def insert_translation(source_text, translated_text, warnings, matched_terms,
                        input_tokens=None, output_tokens=None, user_id=None):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO "Translation"
                    ("sourceText", "translatedText", "warnings", "matchedTerms",
                     "inputTokens", "outputTokens", "userId", "updatedAt")
                VALUES (%s, %s, %s, %s, %s, %s, %s, now())
                RETURNING id
                """,
                [
                    source_text,
                    translated_text,
                    json.dumps(warnings, ensure_ascii=False),
                    json.dumps(matched_terms, ensure_ascii=False),
                    input_tokens,
                    output_tokens,
                    user_id,
                ],
            )
            conn.commit()
            return cur.fetchone()["id"]
