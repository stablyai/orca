// SyncTeX for createPdfParagraphFixture, written by hand so e2e needs no TeX install: one hbox
// per fixture line at that line's baseline, sourced from a line of `texPath`.
import { PARAGRAPH_FIXTURE_LINES, type PdfFixtureLine } from './pdf-paragraph-fixture'

// sp per PDF big point (72.27 TeX pt per 72 bp × 65536 sp per pt).
const SP_PER_BP = 65781.76

const sp = (bp: number): number => Math.round(bp * SP_PER_BP)

export function createParagraphFixtureSynctex(
  texPath: string,
  sourceLines: readonly number[],
  lines: readonly PdfFixtureLine[] = PARAGRAPH_FIXTURE_LINES
): string {
  const boxes = lines.flatMap((line, index) => {
    const source = sourceLines[index]
    // Helvetica averages about half the font size per character.
    const width = Math.min(line.text.length * line.size * 0.5, 612 - 72 - line.x)
    return [
      `(1,${source}:${sp(line.x)},${sp(line.top)}:${sp(width)},${sp(line.size * 0.7)},${sp(line.size * 0.2)}`,
      `g1,${source}:${sp(line.x)},${sp(line.top)}`,
      ')'
    ]
  })
  return [
    'SyncTeX Version:1',
    `Input:1:${texPath}`,
    'Output:pdf',
    'Magnification:1000',
    'Unit:1',
    'X Offset:0',
    'Y Offset:0',
    'Content:',
    '{1',
    `[1,1:0,0:${sp(612)},${sp(792)},0`,
    ...boxes,
    ']',
    '}1',
    'Postamble:',
    ''
  ].join('\n')
}
