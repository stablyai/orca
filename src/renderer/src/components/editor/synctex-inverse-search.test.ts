import { describe, expect, it } from 'vitest'
import {
  parseSynctex,
  synctexInverseSearch,
  synctexSourceRangesInRect
} from './synctex-inverse-search'

// 65781.76 sp = 1 PDF point, so coordinates below read as `points * BP`.
const BP = 65781.76

function sp(points: number): number {
  return Math.round(points * BP)
}

function synctexFile({
  offset = 0,
  magnification = 1000,
  unit = 1,
  postScriptum = [],
  body
}: {
  offset?: number
  magnification?: number
  unit?: number
  postScriptum?: string[]
  body: string[]
}): string {
  return [
    'SyncTeX Version:1',
    'Input:1:/project/./main.tex',
    'Input:2:/project/./chapter.tex',
    'Output:pdf',
    `Magnification:${magnification}`,
    `Unit:${unit}`,
    `X Offset:${offset}`,
    `Y Offset:${offset}`,
    'Content:',
    '{1',
    ...body,
    '}1',
    'Postamble:',
    ...(postScriptum.length > 0 ? ['Post scriptum:', ...postScriptum] : [])
  ].join('\n')
}

// One paragraph line spanning x=100..400 at baseline y=200, closed on source
// line 9, whose words came from lines 5 and 6. The leading `x` record carries
// the paragraph-end line, as TeX writes it.
const paragraphLine = [
  `[1,9:${sp(100)},${sp(300)}:${sp(300)},${sp(120)},0`,
  `(1,9:${sp(100)},${sp(200)}:${sp(300)},${sp(8)},${sp(2)}`,
  `x1,9:${sp(130)},${sp(200)}`,
  `k1,5:${sp(135)},${sp(200)}:${sp(3)}`,
  `x1,5:${sp(180)},${sp(200)}`,
  `k1,6:${sp(250)},${sp(200)}:${sp(3)}`,
  `x1,6:${sp(300)},${sp(200)}`,
  ')',
  `(2,3:${sp(100)},${sp(260)}:${sp(300)},${sp(8)},${sp(2)}`,
  `k2,3:${sp(140)},${sp(260)}:${sp(3)}`,
  ')',
  ']'
]

describe('synctexInverseSearch', () => {
  const doc = parseSynctex(synctexFile({ body: paragraphLine }))

  it('returns the line a word came from, not the paragraph-end line of its box', () => {
    expect(synctexInverseSearch(doc, 1, 110, 197)).toEqual({
      filePath: '/project/main.tex',
      line: 5
    })
    expect(synctexInverseSearch(doc, 1, 200, 197)).toEqual({
      filePath: '/project/main.tex',
      line: 5
    })
    expect(synctexInverseSearch(doc, 1, 320, 197)).toEqual({
      filePath: '/project/main.tex',
      line: 6
    })
  })

  it('resolves text from an \\input file to that file', () => {
    expect(synctexInverseSearch(doc, 1, 200, 258)).toEqual({
      filePath: '/project/chapter.tex',
      line: 3
    })
  })

  it('falls back to the nearest box for clicks between lines', () => {
    expect(synctexInverseSearch(doc, 1, 200, 250)?.filePath).toBe('/project/chapter.tex')
  })

  it('applies the X/Y Offset header that DVI-routed builds write', () => {
    const dvi = parseSynctex(
      synctexFile({
        offset: sp(72),
        body: [
          `(1,4:${sp(100 - 72)},${sp(200 - 72)}:${sp(300)},${sp(8)},${sp(2)}`,
          `k1,4:${sp(110 - 72)},${sp(200 - 72)}:${sp(3)}`,
          ')'
        ]
      })
    )
    expect(synctexInverseSearch(dvi, 1, 200, 197)).toEqual({
      filePath: '/project/main.tex',
      line: 4
    })
  })

  it('returns null for a page with no boxes', () => {
    expect(synctexInverseSearch(doc, 2, 200, 197)).toBeNull()
  })

  it('reads compressed points (`x,=`) as repeating the last full point’s second coordinate', () => {
    const compressed = parseSynctex(
      synctexFile({
        body: [
          `(1,9:${sp(100)},${sp(200)}:${sp(300)},${sp(8)},${sp(2)}`,
          `k1,5:${sp(250)},=:${sp(3)}`,
          ')',
          `(1,9:${sp(100)},${sp(260)}:${sp(300)},${sp(8)},${sp(2)}`,
          `k1,7:${sp(110)},=:${sp(3)}`,
          ')'
        ]
      })
    )
    expect(synctexInverseSearch(compressed, 1, 300, 197)?.line).toBe(5)
    expect(synctexInverseSearch(compressed, 1, 200, 257)?.line).toBe(7)
  })

  it('keeps the box stack in step when an opener cannot be read', () => {
    const unreadable = parseSynctex(
      synctexFile({
        body: [
          `(1,9:${sp(100)},${sp(200)}:${sp(300)},${sp(8)},${sp(2)}`,
          '[not a link',
          ']',
          `k1,3:${sp(110)},${sp(200)}:${sp(3)}`,
          ')'
        ]
      })
    )
    expect(synctexInverseSearch(unreadable, 1, 200, 197)?.line).toBe(3)
  })

  it('does not credit a void hbox as the line a word came from', () => {
    const withVoidBox = parseSynctex(
      synctexFile({
        body: [
          `(1,9:${sp(100)},${sp(200)}:${sp(300)},${sp(8)},${sp(2)}`,
          `k1,4:${sp(110)},${sp(200)}:${sp(3)}`,
          `h1,42:${sp(200)},${sp(200)}:0,0,0`,
          ')'
        ]
      })
    )
    expect(synctexInverseSearch(withVoidBox, 1, 250, 197)?.line).toBe(4)
  })

  it('magnifies coordinates but not the X/Y Offset, as synctex_parser.c does', () => {
    const magnified = parseSynctex(
      synctexFile({
        offset: sp(72),
        magnification: 2000,
        body: [
          `(1,4:${sp((100 - 72) / 2)},${sp((200 - 72) / 2)}:${sp(150)},${sp(4)},${sp(1)}`,
          `k1,4:${sp((110 - 72) / 2)},${sp((200 - 72) / 2)}:${sp(3)}`,
          ')'
        ]
      })
    )
    // A rect over where the line really is: a magnified offset would put the box elsewhere.
    expect(
      synctexSourceRangesInRect(magnified, 1, { left: 90, top: 190, right: 410, bottom: 205 })
    ).toEqual([{ filePath: '/project/main.tex', startLine: 4, endLine: 4 }])
  })

  it('applies a Post scriptum Magnification as a multiplier on the preamble one', () => {
    // 2000‰ in the preamble times 2 in the post scriptum: raw coordinates are a quarter size.
    const scaled = parseSynctex(
      synctexFile({
        magnification: 2000,
        postScriptum: ['Magnification:2'],
        body: [
          `(1,4:${sp(100 / 4)},${sp(200 / 4)}:${sp(75)},${sp(2)},${sp(0.5)}`,
          `k1,4:${sp(110 / 4)},${sp(200 / 4)}:${sp(3)}`,
          ')'
        ]
      })
    )
    expect(
      synctexSourceRangesInRect(scaled, 1, { left: 90, top: 190, right: 410, bottom: 205 })
    ).toEqual([{ filePath: '/project/main.tex', startLine: 4, endLine: 4 }])
  })

  it('reads a Post scriptum offset as a dimension, not in preamble Units', () => {
    // Unit:2 doubles raw coordinates, but `72bp` stays 72bp: it is not a count of Units.
    const withUnits = parseSynctex(
      synctexFile({
        unit: 2,
        postScriptum: ['X Offset:72bp', 'Y Offset:72bp'],
        body: [
          `(1,4:${sp((100 - 72) / 2)},${sp((200 - 72) / 2)}:${sp(150)},${sp(4)},${sp(1)}`,
          `k1,4:${sp((110 - 72) / 2)},${sp((200 - 72) / 2)}:${sp(1.5)}`,
          ')'
        ]
      })
    )
    expect(
      synctexSourceRangesInRect(withUnits, 1, { left: 90, top: 190, right: 410, bottom: 205 })
    ).toEqual([{ filePath: '/project/main.tex', startLine: 4, endLine: 4 }])
  })

  it('lets a Post scriptum offset override the preamble', () => {
    const overridden = parseSynctex(
      synctexFile({
        postScriptum: [`X Offset:${sp(72)}`, `Y Offset:${sp(72)}`],
        body: [
          `(1,4:${sp(100 - 72)},${sp(200 - 72)}:${sp(300)},${sp(8)},${sp(2)}`,
          `k1,4:${sp(110 - 72)},${sp(200 - 72)}:${sp(3)}`,
          ')'
        ]
      })
    )
    expect(
      synctexSourceRangesInRect(overridden, 1, { left: 90, top: 190, right: 410, bottom: 205 })
    ).toEqual([{ filePath: '/project/main.tex', startLine: 4, endLine: 4 }])
  })
})

describe('synctexSourceRangesInRect', () => {
  const doc = parseSynctex(synctexFile({ body: paragraphLine }))

  it('covers every line typeset inside the rect, merged per file', () => {
    expect(
      synctexSourceRangesInRect(doc, 1, { left: 100, top: 190, right: 400, bottom: 265 })
    ).toEqual([
      { filePath: '/project/main.tex', startLine: 5, endLine: 6 },
      { filePath: '/project/chapter.tex', startLine: 3, endLine: 3 }
    ])
  })

  it('credits a word to the record it started at, even with no record inside the rect', () => {
    expect(
      synctexSourceRangesInRect(doc, 1, { left: 190, top: 195, right: 240, bottom: 201 })
    ).toEqual([{ filePath: '/project/main.tex', startLine: 5, endLine: 5 }])
  })

  it('ignores a line the box only grazes', () => {
    // The main.tex line spans y=192..202; a box from y=200 down covers the chapter line only.
    expect(
      synctexSourceRangesInRect(doc, 1, { left: 100, top: 200, right: 400, bottom: 265 })
    ).toEqual([{ filePath: '/project/chapter.tex', startLine: 3, endLine: 3 }])
  })

  it('returns nothing for empty space', () => {
    expect(synctexSourceRangesInRect(doc, 1, { left: 10, top: 10, right: 50, bottom: 50 })).toEqual(
      []
    )
  })
})
