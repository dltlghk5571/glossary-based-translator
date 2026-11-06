import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildTemplate, readUploadRows, UploadFormatError } from "./glossary-excel.ts";

const LABELS = ["일반", "기구", "규정"];
const EXAMPLES = [
  { korean: "총학생회", english: "Undergraduate Student Council", type: "기구", aliases: "총학", usageNote: "공식 기구명으로만 사용" },
  { korean: "회칙", english: "Constitution", type: "규정", aliases: "", usageNote: "" },
  { korean: "회장", english: "President", type: "직책", aliases: "", usageNote: "" },
];

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    assert.ok(e instanceof UploadFormatError, `expected UploadFormatError, got ${e}`);
    return e.code;
  }
}

test("the template reads back as exactly its example rows", async () => {
  const rows = await readUploadRows(await buildTemplate(LABELS, EXAMPLES));
  assert.deepEqual(rows, EXAMPLES.map((e, i) => ({ rowNumber: i + 3, ...e })));
});

test("the template has the guide sheet and a 분류 dropdown", async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildTemplate(LABELS, EXAMPLES));
  assert.ok(wb.getWorksheet("작성 방법"));
  const validation = wb.getWorksheet("용어집")!.getCell("C10").dataValidation;
  assert.equal(validation.type, "list");
});

test("columns are found by header, and non-string cells read as trimmed text", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("용어집");
  ws.addRow(["영어 번역", "한국어 용어", "사용 메모"]);
  ws.addRow([{ richText: [{ text: "Student " }, { text: "Council" }] }, 2026, "  회의  "]);
  const rows = await readUploadRows(await toBuffer(wb));
  assert.deepEqual(rows, [
    { rowNumber: 2, korean: "2026", english: "Student Council", type: "", aliases: "", usageNote: "회의" },
  ]);
});

test("a file that is not xlsx is unreadable", async () => {
  assert.equal(await codeOf(readUploadRows(Buffer.from("not a zip"))), "unreadable");
});

test("a workbook without the 용어집 sheet is rejected", async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Sheet1").addRow(["한국어 용어", "영어 번역"]);
  assert.equal(await codeOf(readUploadRows(await toBuffer(wb))), "no_sheet");
});

test("a sheet without the 영어 번역 header is rejected", async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("용어집").addRow(["한국어 용어", "분류"]);
  assert.equal(await codeOf(readUploadRows(await toBuffer(wb))), "missing_header");
});

test("more than 2,000 data rows is rejected", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("용어집");
  ws.addRow(["한국어 용어", "영어 번역"]);
  for (let i = 0; i < 2001; i++) ws.addRow([`용어${i}`, `Term ${i}`]);
  assert.equal(await codeOf(readUploadRows(await toBuffer(wb))), "too_many_rows");
});

test("hyperlink, rich-text hyperlink, formula and date cells read as their displayed text", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("용어집");
  ws.addRow(["한국어 용어", "영어 번역", "다른 표기", "사용 메모"]);
  ws.addRow([
    { text: "링크", hyperlink: "https://example.com" },
    { text: { richText: [{ text: "Rich " }, { font: { bold: true }, text: "Link" }] }, hyperlink: "https://example.com" },
    { formula: "\"계\"&\"산\"", result: "계산" },
    new Date(Date.UTC(2026, 0, 5)),
  ]);
  const rows = await readUploadRows(await toBuffer(wb));
  assert.deepEqual(rows, [
    { rowNumber: 2, korean: "링크", english: "Rich Link", type: "", aliases: "계산", usageNote: "2026-01-05" },
  ]);
});
