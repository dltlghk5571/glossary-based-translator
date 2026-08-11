import os

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

load_dotenv()


def get_connection():
    """New connection per call -- Vercel Python functions are stateless per
    invocation, so a pool would just add complexity for no benefit here."""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL environment variable is not set.")
    return psycopg.connect(database_url, row_factory=dict_row)
