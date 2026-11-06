// Excel template + upload reader for the glossary import. Only package and
// type imports here: `node --test` loads this file directly (see glossary-import.ts).
import ExcelJS from "exceljs";
import type { UploadRow } from "./glossary-import";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_DATA_ROWS = 2000;

export type UploadFormatErrorCode = "unreadable" | "no_sheet" | "missing_header" | "too_many_rows" | "too_large";

export class UploadFormatError extends Error {
  code: UploadFormatErrorCode;
  constructor(code: UploadFormatErrorCode) {
    super(code);
    this.code = code;
  }
}

const SHEET = "용어집";
const GUIDE_SHEET = "작성 방법";
const COLUMNS = [
  { header: "한국어 용어", key: "korean", marker: "필수", width: 20 },
  { header: "영어 번역", key: "english", marker: "필수", width: 32 },
  { header: "분류", key: "type", marker: "선택", width: 12 },
  { header: "다른 표기", key: "aliases", marker: "선택", width: 20 },
  { header: "사용 메모", key: "usageNote", marker: "선택", width: 32 },
] as const;

const GUIDE_LINES = [
  "1행의 제목은 바꾸지 마세요. 2행(필수/선택)과 예시 3줄은 올릴 때 자동으로 무시됩니다.",
  "한국어 용어, 영어 번역은 반드시 채워야 합니다.",
  "분류는 목록에서 고르세요. 비워 두면 '일반'으로 등록됩니다.",
  "다른 표기는 같은 뜻의 다른 한국어 표현이며 쉼표(,)로 여러 개 적을 수 있습니다.",
  "이미 등록된 용어와 겹치는 행은 검수자가 확인한 뒤에만 반영됩니다.",
];

export async function buildTemplate(typeLabels: string[], examples: Omit<UploadRow, "rowNumber">[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET);
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  ws.addRow(COLUMNS.map((c) => c.header)).font = { bold: true };
  ws.addRow(COLUMNS.map((c) => c.marker)).font = { italic: true, color: { argb: "FF888888" } };
  for (const e of examples) ws.addRow(COLUMNS.map((c) => e[c.key]));
  for (let r = 3; r <= MAX_DATA_ROWS + 2; r++) {
    ws.getCell(`C${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${typeLabels.join(",")}"`],
    };
  }

  const guide = wb.addWorksheet(GUIDE_SHEET);
  guide.getColumn(1).width = 90;
  for (const line of GUIDE_LINES) guide.addRow([line]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// The text a person sees in the cell. exceljs' `cell.text` is not always a
// string: a hyperlink with mixed formatting yields { richText }, and a date
// yields Date.toString() -- normalize both.
function cellText(cell: ExcelJS.Cell): string {
  if (cell.value instanceof Date) return cell.value.toISOString().slice(0, 10);
  const t: unknown = cell.text;
  if (typeof t === "string") return t.trim();
  if (t && typeof t === "object" && "richText" in t && Array.isArray(t.richText)) {
    return t.richText.map((r: { text?: string }) => r.text ?? "").join("").trim();
  }
  return String(t ?? "").trim();
}

export async function readUploadRows(buf: Buffer): Promise<UploadRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new UploadFormatError("unreadable");
  }
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new UploadFormatError("no_sheet");

  const colOf: Partial<Record<(typeof COLUMNS)[number]["key"], number>> = {};
  ws.getRow(1).eachCell((cell, col) => {
    const found = COLUMNS.find((c) => c.header === cellText(cell));
    if (found) colOf[found.key] = col;
  });
  if (!colOf.korean || !colOf.english) throw new UploadFormatError("missing_header");

  const rows: UploadRow[] = [];
  ws.eachRow((wsRow, rowNumber) => {
    if (rowNumber === 1) return;
    const read = (key: (typeof COLUMNS)[number]["key"]) => (colOf[key] ? cellText(wsRow.getCell(colOf[key]!)) : "");
    const r: UploadRow = {
      rowNumber,
      korean: read("korean"),
      english: read("english"),
      type: read("type"),
      aliases: read("aliases"),
      usageNote: read("usageNote"),
    };
    if (rowNumber === 2 && r.korean === "필수") return;
    if (!r.korean && !r.english && !r.type && !r.aliases && !r.usageNote) return;
    rows.push(r);
  });
  if (rows.length > MAX_DATA_ROWS) throw new UploadFormatError("too_many_rows");
  return rows;
}
