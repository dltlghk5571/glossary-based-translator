import os
import argparse
import pandas as pd
import csv
import time

from dotenv import load_dotenv

load_dotenv()

class GlossaryMatcher:
    def __init__(self, glossary_path='glossary.csv'):
        self.glossary_path = glossary_path
        self.glossary = {}
        self._load_glossary()

    def _load_glossary(self):
        if not os.path.exists(self.glossary_path):
            print(f"Warning: {self.glossary_path} not found.")
            return

        try:
            # Load CSV into dictionary for fast lookup
            # Assuming glossary.csv has 'Korean' and 'English' columns
            df = pd.read_csv(self.glossary_path)
            # Create a dictionary Korean -> English
            # Verify columns exist
            if 'Korean' in df.columns and 'English' in df.columns:
                # Iterate and add to dict
                for _, row in df.iterrows():
                    k = str(row['Korean']).strip()
                    e = str(row['English']).strip()
                    if k:
                        self.glossary[k] = e
        except Exception as e:
            print(f"Error loading glossary: {e}")

    def get_relevant_terms(self, text):
        """
        Finds all glossary terms that appear in the input text.
        Returns a dictionary of found terms {Korean: English}.
        """
        relevant_terms = {}
        # Simple exact match search. 
        # For efficiency with large text, could use Aho-Corasick, but for now simple loop is fine.
        for k, e in self.glossary.items():
            if k in text:
                relevant_terms[k] = e
        return relevant_terms

class TranslationSystem:
    def __init__(self, api_key):
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        self.model = genai.GenerativeModel('gemini-2.0-flash')
        self.matcher = GlossaryMatcher()




    def _generate_with_retry(self, prompt, max_retries=3):
        for attempt in range(max_retries):
            try:
                response = self.model.generate_content(prompt)
                return response
            except Exception as e:
                if "429" in str(e):
                    if attempt < max_retries - 1:
                        wait_time = (attempt + 1) * 5  # 5s, 10s, 15s
                        print(f"   (Rate limit hit. Retrying in {wait_time}s...)")
                        time.sleep(wait_time)
                        continue
                raise e
        return None

    def analyze_caution_words(self, text):
        prompt = f"""
        Analyze the following Korean text and list the key technical terms, proper nouns, or domain-specific words that are critical for accurate translation.
        Output ONLY the list of words separated by commas, nothing else.

        Text: "{text}"
        """
        try:
            response = self._generate_with_retry(prompt)
            words = [w.strip() for w in response.text.split(',')]
            return words
        except Exception as e:
            print(f"Error analyzing caution words: {e}")
            return []

    def translate_with_context(self, text, caution_words):
        # 1. RAG: Get glossary terms
        relevant_terms = self.matcher.get_relevant_terms(text)
        
        # Format glossary content
        glossary_context = ""
        if relevant_terms:
            glossary_context = "Use the following glossary terms (Strictly adhere to these):\n"
            for k, e in relevant_terms.items():
                glossary_context += f"- {k}: {e}\n"
        
        # Add caution words to context
        caution_context = ""
        if caution_words:
            caution_context = "Pay special attention to these technical terms:\n" + ", ".join(caution_words)

        prompt = f"""
        Translate the following Korean text to English.
        Maintain the original paragraph structure and formatting.
        
        {glossary_context}
        {caution_context}
        
        Source Text:
        "{text}"
        
        Output only the translated English text.
        """
        
        try:
            response = self._generate_with_retry(prompt)
            return response.text.strip(), relevant_terms
        except Exception as e:
            return f"Error: {str(e)}", relevant_terms

    def generate_title(self, text, translated_text):
        prompt = f"""
        Generate a concise and professional English title for the following text.
        Output ONLY the title, nothing else.
        
        Text Summary:
        {translated_text[:500]}...
        """
        try:
            response = self._generate_with_retry(prompt)
            return response.text.strip().replace('"', '')
        except Exception as e:
            return "Untitled"

def _require_api_key():
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise SystemExit(
            "GOOGLE_API_KEY environment variable is not set.\n"
            "Set it before running, e.g.:\n"
            '  export GOOGLE_API_KEY="your_google_api_key_here"'
        )
    return api_key


def legacy_main():
    """Original simple RAG pipeline, kept for backward compatibility (--legacy)."""
    api_key = _require_api_key()

    translator = TranslationSystem(api_key)

    print("\n--- Korean to English Translation System (RAG) ---")

    input_file = "input.txt"
    output_file = "output.txt"

    if not os.path.exists(input_file):
        print(f"'{input_file}' not found. Creating placeholder.")
        with open(input_file, "w", encoding="utf-8") as f:
            f.write("여기에 번역할 내용을 입력하세요.")
        return

    print(f"Reading from {input_file}...")
    with open(input_file, "r", encoding="utf-8") as f:
        content = f.read().strip()

    if not content:
        print("Input file is empty.")
        return

    print("Step 1: Analyzing Caution Words...")
    caution_words = translator.analyze_caution_words(content)
    print(f" - Found {len(caution_words)} words.")
    time.sleep(2) # Prevent Rate Limit

    print("Step 2: Translating...")
    translated_text, relevant_terms = translator.translate_with_context(content, caution_words)
    time.sleep(2) # Prevent Rate Limit

    print("Step 3: Generating Title...")
    title = translator.generate_title(content, translated_text)

    # Gap Analysis
    missing_glossary_terms = []
    for word in caution_words:
        covered = False
        if word in translator.matcher.glossary:
            covered = True
        else:
            for k in relevant_terms:
                if word in k:
                    covered = True
                    break
        if not covered:
            missing_glossary_terms.append(word)

    # Write Output
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(f"제목:\n {title}\n\n")
        f.write(f"본문:\n {translated_text}\n\n")
        f.write("="*40 + "\n")
        f.write("[Analysis Report]\n")

        if relevant_terms:
            f.write("\nGlossary Terms Used:\n")
            for k, e in relevant_terms.items():
                f.write(f" - {k} : {e}\n")

        if missing_glossary_terms:
            f.write("\nCaution - Terms NOT in Glossary:\n")
            for w in missing_glossary_terms:
                f.write(f" - {w}\n")

    print(f"\nDone! Saved to {output_file}")


def _build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Glossary-controlled, human-in-the-loop Korean->English translator."
    )
    parser.add_argument("--input", default="input.txt", help="Path to the Korean source text file.")
    parser.add_argument("--output", default="output.txt", help="Path to write the final English translation.")
    parser.add_argument("--glossary", default="glossary.csv", help="Path to glossary.csv.")
    parser.add_argument("--review-missing", dest="review_missing", default=None,
                         help="Path to save detected missing terms as JSON.")
    parser.add_argument("--save-audit", dest="save_audit", default=None,
                         help="Path to save the glossary audit report as JSON.")
    parser.add_argument("--dry-run", action="store_true",
                         help="Only extract candidate/missing terms; don't translate.")
    parser.add_argument("--legacy", action="store_true",
                         help="Run the original simple glossary-substring pipeline.")

    interactive_group = parser.add_mutually_exclusive_group()
    interactive_group.add_argument("--interactive", dest="interactive", action="store_true", default=True,
                                    help="Prompt for missing high-priority glossary terms (default).")
    interactive_group.add_argument("--no-interactive", dest="interactive", action="store_false",
                                    help="Never prompt; log warnings for missing high-priority terms instead.")
    return parser


def main():
    parser = _build_arg_parser()
    args = parser.parse_args()

    if args.legacy:
        legacy_main()
        return

    import json
    import translation_graph
    import llm_providers

    generate_fns = llm_providers.build_generate_fns()

    if not os.path.exists(args.input):
        print(f"'{args.input}' not found.")
        return

    with open(args.input, "r", encoding="utf-8") as f:
        raw_text = f.read().strip()

    if not raw_text:
        print("Input file is empty.")
        return

    if args.dry_run:
        nodes = translation_graph.make_nodes(generate_fns)
        state = {"raw_text": raw_text, "glossary_path": args.glossary}
        state.update(nodes["load_glossary"](state))
        state.update(nodes["migrate_glossary_if_needed"](state))
        state.update(nodes["extract_candidate_terms"](state))
        state.update(nodes["match_existing_glossary_terms"](state))
        state.update(nodes["detect_missing_terms"](state))

        print("\n--- Candidate Terms ---")
        print(json.dumps(state["candidate_terms"], ensure_ascii=False, indent=2))
        print("\n--- Missing Terms (not yet in glossary) ---")
        print(json.dumps(state["missing_terms"], ensure_ascii=False, indent=2))

        if args.review_missing:
            with open(args.review_missing, "w", encoding="utf-8") as f:
                json.dump(state["missing_terms"], f, ensure_ascii=False, indent=2)
            print(f"\nSaved missing terms to {args.review_missing}")
        return

    result = translation_graph.run_pipeline(
        raw_text, args.glossary, generate_fns, interactive=args.interactive
    )

    final_translation = result.get("final_translation", "")
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(final_translation)
    print(f"\nDone! Saved translation to {args.output}")

    if result.get("warnings"):
        print("\n--- Warnings ---")
        for w in result["warnings"]:
            print(f" - {w}")

    if args.review_missing:
        with open(args.review_missing, "w", encoding="utf-8") as f:
            json.dump(result.get("missing_terms", []), f, ensure_ascii=False, indent=2)
        print(f"Saved missing terms to {args.review_missing}")

    if args.save_audit:
        with open(args.save_audit, "w", encoding="utf-8") as f:
            json.dump(result.get("audit_report", {}), f, ensure_ascii=False, indent=2)
        print(f"Saved audit report to {args.save_audit}")


if __name__ == "__main__":
    main()
