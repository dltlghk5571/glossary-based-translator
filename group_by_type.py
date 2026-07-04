import pandas as pd
import os

def main():
    # Use the previously classified file or re-classify if needed. 
    # Since we just ran the classification, let's load the output of the previous step 
    # to ensure consistency, or simple logic: read CSV and apply 'classify_glossary.py' logic.
    # To be safe and self-contained, I will import the function from classify_glossary if possible, 
    # but since I can't easily import from a script without some path hacking or refactoring, 
    # I'll just rely on loading the 'glossary_classified.xlsx' which should be correct.
    
    input_file = 'glossary_classified.xlsx'
    if not os.path.exists(input_file):
        print(f"Error: {input_file} not found. Please run classify_glossary.py first.")
        return

    output_file = 'glossary_grouped_by_type.xlsx'
    
    try:
        df = pd.read_excel(input_file)
        print(f"Read {len(df)} rows from {input_file}")
    except Exception as e:
        print(f"Error reading Excel: {e}")
        return

    # Sort: Primary = Type, Secondary = Korean
    df_sorted = df.sort_values(by=['Type', 'Korean'])
    
    try:
        with pd.ExcelWriter(output_file, engine='openpyxl') as writer:
            # 1. Master Sheet: All Sorted by Type
            df_sorted.to_excel(writer, sheet_name='All_Sorted_by_Type', index=False)
            
            # 2. Separate Sheets for each Type
            # Get unique types and sort them so sheets are in order
            types = sorted(df['Type'].dropna().unique())
            
            for t in types:
                # Create a clean sheet name (remove invalid chars if any, though our types are safe)
                safe_sheet_name = t.split('(')[0].strip().replace('/', '_')[:31] # Excel sheet name limit 31 chars
                
                # Filter data
                df_type = df[df['Type'] == t].sort_values(by='Korean')
                
                # Write to sheet
                df_type.to_excel(writer, sheet_name=safe_sheet_name, index=False)
                print(f"Added sheet: {safe_sheet_name} ({len(df_type)} rows)")
                
        print(f"\nSuccessfully created {output_file}")
        
    except Exception as e:
        print(f"Error saving Excel: {e}")

if __name__ == "__main__":
    main()
