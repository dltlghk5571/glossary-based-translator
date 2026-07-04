TERM_EXTRACTION_PROMPT = """You are refining candidate glossary terms from a Korean student
society (학생사회) document. Rule-based pattern matching already produced a rough list of
candidate terms. Your job is to decide which candidates truly need a fixed, one-to-one
English translation, and to discard noise.

Extract terms such as:
- Organization names (조직명): 총학생회, 중앙운영위원회, 선거관리위원회
- Roles/positions (직위/직책명): 총학생회장, 감사위원, 대의원
- Regulations/institutional documents (규정/제도/문서명): 학생회칙, 선거시행세칙, 의결안
- Election/resolution/meeting procedure terms: 입후보, 정족수, 의결권, 표결, 인준, 가결, 부결
- Finance/audit terms: 예산안, 결산, 회계감사
- Any term repeated across the document where translation consistency matters

Do NOT extract:
- Generic nouns or verbs (e.g. 논의하다, 진행하다, 결과, 내용, 문제, 방향, 필요하다, 가능하다)
- Expressions that read fine when paraphrased freely
- Terms that appear only once with weak institutional meaning
- Terms that would sound awkward if forced into a fixed translation

Rule-based candidates found in the text:
{rule_candidates}

Source text:
\"\"\"
{text}
\"\"\"

Return ONLY a JSON array, no prose, no markdown fences. Each item must have exactly these
keys:
[
  {{
    "ko_term": "...",
    "type": "Organization" | "Regulation" | "Role/Position" | "Election" | "Finance" | "Meeting/Procedure" | "Academic" | "General",
    "reason": "...",
    "context_sentence": "the sentence from the source text where this term appears",
    "suggested_translation": "...",
    "priority": "high" | "medium" | "low"
  }}
]
"""


TRANSLATION_PROMPT = """Translate the following Korean student society document into natural English.

Rules:
1. Use the glossary translations exactly.
2. Do not paraphrase glossary terms.
3. Preserve institutional, procedural, electoral, financial, and regulatory meaning.
4. Use formal but readable English.
5. Do not add information not present in the source.
6. Preserve placeholders exactly, such as __TERM_001__, __TERM_002__.
7. Do not translate, modify, split, or remove placeholders.
8. Keep the tone appropriate for student society documents.

Source Text:
\"\"\"
{text}
\"\"\"

Output only the translated English text.
"""


REPAIR_PROMPT = """The translation below violates the glossary rules.
Revise only the incorrect glossary-related parts.
Do not rewrite unrelated sentences.
Use the required glossary translations exactly.

Glossary violations:
{violations}

Original Korean:
{original_text}

Current English translation:
{current_translation}

Return only the corrected English translation.
"""


def build_term_extraction_prompt(text, rule_candidates):
    candidates_str = ", ".join(sorted(set(rule_candidates))) if rule_candidates else "(none)"
    return TERM_EXTRACTION_PROMPT.format(rule_candidates=candidates_str, text=text)


def build_translation_prompt(protected_text):
    return TRANSLATION_PROMPT.format(text=protected_text)


def build_repair_prompt(violations, original_text, current_translation):
    violations_str = "\n".join(
        f"- {v['ko_term']}: required \"{v['required_en_term']}\", found \"{v['found']}\" ({v['issue']})"
        for v in violations
    )
    return REPAIR_PROMPT.format(
        violations=violations_str,
        original_text=original_text,
        current_translation=current_translation,
    )
