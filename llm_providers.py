import os
import time

from dotenv import load_dotenv

load_dotenv()

DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-5",
    "openai": os.environ.get("OPENAI_MODEL", "gpt-4o"),
    "google": "gemini-2.0-flash",
}

# Which provider handles each pipeline step by default. Claude (Anthropic) is
# the default for all three: term extraction needs reliable structured JSON
# output and nuanced classification of institutional terms; translation and
# repair need strict instruction-following (glossary terms and __TERM_NNN__
# placeholders must be preserved exactly, never paraphrased). Override any
# step independently with TERM_EXTRACTION_PROVIDER / TRANSLATION_PROVIDER /
# REPAIR_PROVIDER (values: anthropic, openai, google).
TASK_DEFAULT_PROVIDER = {
    "term_extraction": "anthropic",
    "translation": "anthropic",
    "repair": "anthropic",
}


def _require_key(env_var):
    key = os.environ.get(env_var)
    if not key:
        raise SystemExit(
            f"{env_var} environment variable is not set.\n"
            "Set it before running, e.g.:\n"
            f'  export {env_var}="your_api_key_here"'
        )
    return key


def call_anthropic(prompt, model=None):
    import anthropic
    client = anthropic.Anthropic(api_key=_require_key("ANTHROPIC_API_KEY"))
    response = client.messages.create(
        model=model or os.environ.get("ANTHROPIC_MODEL", DEFAULT_MODELS["anthropic"]),
        max_tokens=8000,
        messages=[{"role": "user", "content": prompt}],
    )
    for block in response.content:
        if block.type == "text":
            return block.text
    return ""


def call_openai(prompt, model=None):
    from openai import OpenAI
    client = OpenAI(api_key=_require_key("OPENAI_API_KEY"))
    response = client.chat.completions.create(
        model=model or DEFAULT_MODELS["openai"],
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content


def call_google(prompt, model=None):
    import google.generativeai as genai
    genai.configure(api_key=_require_key("GOOGLE_API_KEY"))
    gen_model = genai.GenerativeModel(model or os.environ.get("GOOGLE_MODEL", DEFAULT_MODELS["google"]))
    return gen_model.generate_content(prompt).text


PROVIDER_FUNCS = {
    "anthropic": call_anthropic,
    "openai": call_openai,
    "google": call_google,
}


def _with_retry(call_fn, prompt, max_retries=3):
    for attempt in range(max_retries):
        try:
            return call_fn(prompt)
        except Exception as e:
            is_rate_limit = "429" in str(e) or "rate_limit" in str(e).lower()
            if is_rate_limit and attempt < max_retries - 1:
                time.sleep((attempt + 1) * 5)
                continue
            raise
    return ""


def get_generate_fn(task):
    """Return a generate(prompt) -> text function for a pipeline task
    ("term_extraction", "translation", or "repair"), honoring the
    <TASK>_PROVIDER env var override (default: TASK_DEFAULT_PROVIDER)."""
    provider = os.environ.get(f"{task.upper()}_PROVIDER", TASK_DEFAULT_PROVIDER[task]).lower()
    if provider not in PROVIDER_FUNCS:
        raise SystemExit(
            f"Unknown provider '{provider}' for {task.upper()}_PROVIDER. "
            f"Choose one of: {', '.join(PROVIDER_FUNCS)}"
        )
    call_fn = PROVIDER_FUNCS[provider]

    def generate(prompt):
        return _with_retry(call_fn, prompt)

    return generate


def build_generate_fns():
    """Build the {"term_extraction", "translation", "repair"} generate_fn map
    the translation graph needs, one per task, each provider-selected."""
    return {task: get_generate_fn(task) for task in TASK_DEFAULT_PROVIDER}
