// A one-page US Letter PDF with a heading and two paragraphs, laid out like a typeset article:
// 12pt Helvetica on a 14pt pitch, full lines, a short last line, and an indented first line
// for the second paragraph.

export type PdfFixtureLine = { x: number; top: number; size: number; text: string }

const PAGE_HEIGHT = 792

export const PARAGRAPH_FIXTURE_LINES: PdfFixtureLine[] = [
  { x: 72, top: 90, size: 20, text: 'Results' },
  {
    x: 72,
    top: 130,
    size: 12,
    text: 'The first paragraph opens the section and runs across several full lines'
  },
  {
    x: 72,
    top: 144,
    size: 12,
    text: 'so that a click anywhere inside it should pick the whole block at once and'
  },
  {
    x: 72,
    top: 158,
    size: 12,
    text: 'hand the agent every line of it together rather than just one text run of'
  },
  { x: 72, top: 172, size: 12, text: 'the paragraph.' },
  {
    x: 90,
    top: 186,
    size: 12,
    text: 'A second paragraph starts with an indent, which is how typeset papers mark'
  },
  { x: 72, top: 200, size: 12, text: 'a new paragraph without extra space.' }
]

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`)
}

export function createPdfParagraphFixture(
  lines = PARAGRAPH_FIXTURE_LINES,
  { rotate = 0 }: { rotate?: 0 | 90 | 180 | 270 } = {}
): Buffer {
  const stream = `${lines
    .map(
      (line) =>
        `BT /F1 ${line.size} Tf ${line.x} ${PAGE_HEIGHT - line.top} Td (${escapePdfText(line.text)}) Tj ET`
    )
    .join('\n')}\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${PAGE_HEIGHT}] /Rotate ${rotate} /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}
