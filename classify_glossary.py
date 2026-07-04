import pandas as pd
import re

def classify_term(row):
    ko = str(row['Korean']).strip()
    en = str(row['English']).strip().lower()
    
    # Check Keywords in English and Korean
    
    # 1. Election (선거/투표)
    if any(k in en for k in ['election', 'vote', 'poll', 'campaign', 'ballot']) or \
       any(k in ko for k in ['선거', '투표', '개표', '후보']):
        return 'Election (선거/투표)'
        
    # 2. Regulation (회칙/규정)
    if any(k in en for k in ['regulation', 'bylaw', 'constitution', 'rule', 'code', 'clause']) or \
       any(k in ko for k in ['회칙', '규칙', '세칙', '규정', '조항']):
        return 'Regulation (회칙/규정)'
        
    # 3. Finance (재정/예산)
    if any(k in en for k in ['budget', 'finance', 'fee', 'fund', 'bill', 'tax', 'receipt', 'asset', 'income', 'expense', 'cost', 'account']) or \
       any(k in ko for k in ['예산', '회계', '기금', '영수증', '비용', '지출', '수입', '자산', '비품', '금액']):
        return 'Finance (재정/예산)'
        
    # 5. Role/Position (직책) - Checked BEFORE Org/Academic to catch 'Dean of X', 'Class Rep'
    # Specific endings for Role
    role_suffixes_ko = ['장', '위원', '대의원', '대표', '국원', '간부', '이사', '감사', '반장', '부반장', '총무']
    # Exclude these if they end with '원' or '장' but are Orgs
    # e.g. '교육원' (Academy), '운동장' (Playground - unlikely), '시장' (Mayor/Market)
    # Actually '원' is ambiguous. '대학원' (Grad School), '창업원' (Startup Inst), '연구원' (Research Inst/Researcher)
    # Context matters.
    # Safe Role text in English
    role_keywords_en = ['president', 'chairman', 'member', 'delegate', 'representative', 'director', 'dean', 'auditor', 'leader', 'clerk', 'proxy', 'head', 'officer', 'monitor']
    
    if any(k in en for k in role_keywords_en):
        # Check against false positives (e.g. 'Committee Member' is Role. 'Member of Committee' is Role.)
        # 'Board of Audit' -> Contains 'Board'.
        # 'Auditing Committee' -> 'Committee'.
        # 'Auditor' -> Role.
        # But 'Auditing Committee' does NOT contain 'Auditor'. It contains 'Audit'.
        # So 'auditor' is safe.
        return 'Role/Position (직책)'
        
    # Korean suffix check for Roles
    if any(ko.endswith(s) for s in role_suffixes_ko):
        # Exceptions
        if any(ko.endswith(x) for x in ['교육원', '대학원', '창업원', '연구원', '진흥원', '도서관', '생활관']):
             pass # Org
        elif ko == '운동장' or ko == '식당':
             pass # Place
        else:
             return 'Role/Position (직책)'

    # 6. Organization (기구/단체)
    org_keywords_en = ['committee', 'board', 'association', 'union', 'assembly', 'council', 'team', 'office', 'bureau', 
                       'college', 'school', 'center', 'group', 'institute', 'academy', 'headquarters', 'foundation']
    org_keywords_ko = ['위원회', '기구', '학생회', '협의회', '연합회', '총회', '동아리', '이사회', '평의원회', '센터', '팀', '처', '본부', '단', '실']
    
    if any(k in en for k in org_keywords_en) or \
       any(k in ko for k in org_keywords_ko) or \
       any(ko.endswith(x) for x in ['원', '관']) and not any(ko.endswith(r) for r in ['위원', '국원', '대원']): 
        # ends with 원/관 (Inst/Hall) but not Role
        return 'Organization (기구/단체)'

    # 4. Academic (학사) - moved after Role/Org to avoid "Class Rep" being Academic
    if any(k in en for k in ['academic', 'grade', 'credit', 'course', 'major', 'graduation', 'admission', 'scholarship', 'class', 'curriculum', 'degree']) or \
       any(k in ko for k in ['학사', '학점', '성적', '졸업', '입학', '강의', '수강', '전공', '장학', '교과', '학위']):
        return 'Academic (학사)'
        
    # Default
    return 'General (일반)'

def main():
    input_file = 'glossary.csv'
    output_file = 'glossary_classified.xlsx'
    
    try:
        df = pd.read_csv(input_file)
        print(f"Read {len(df)} rows from {input_file}")
    except Exception as e:
        print(f"Error reading CSV: {e}")
        return

    # glossary.csv may now use the extended ko_term/en_term schema instead of
    # the original Korean/English columns -- normalize so the rest of this
    # script (and classify_term) can keep working unchanged.
    if 'Korean' not in df.columns and 'ko_term' in df.columns:
        df = df.rename(columns={'ko_term': 'Korean', 'en_term': 'English'})

    # Add Type column
    df['Type'] = df.apply(classify_term, axis=1)
    
    # Sort by Korean column
    df = df.sort_values(by='Korean')
    
    # Reorder columns (assuming original has Korean, English)
    # Ensure 'Type' is the 3rd column
    cols = df.columns.tolist()
    if 'Type' in cols:
        cols.remove('Type')
    new_cols = cols[:2] + ['Type'] + cols[2:]
    # In case there are extra columns, this handles it, but here we likely just have [Korean, English, Type]
    df = df[['Korean', 'English', 'Type']]
    
    # Save
    try:
        df.to_excel(output_file, index=False)
        print(f"Successfully saved to {output_file}")
        
        # Verify
        print("Sample of first 5 rows:")
        print(df.head())
        
        # Breakdown
        print("\nBreakdown by Type:")
        print(df['Type'].value_counts())
        
    except Exception as e:
        print(f"Error saving Excel: {e}")

if __name__ == "__main__":
    main()
