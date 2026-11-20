import { describe, expect, it } from 'vitest'
import { findTerminalFileLinksAtBufferPosition } from './terminal-link-buffer-hit-testing'

type TestBufferLine = {
  isWrapped: boolean
  length: number
  getCell: (_index: number) => undefined
  translateToString: (
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
    outColumns?: number[]
  ) => string
}

function makeBufferLine(text: string): TestBufferLine {
  const columns = Array.from({ length: text.length + 1 }, (_value, index) => index)
  return {
    isWrapped: false,
    length: text.length,
    getCell: () => undefined,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      if (outColumns) {
        outColumns.length = 0
        for (let index = startColumn; index <= endColumn; index++) {
          outColumns.push(columns[index] ?? index)
        }
      }
      return text.slice(startColumn, endColumn)
    }
  }
}

const WRAPPED_PATH = 'docs/reports/generated-weekly-summary-of-open-items.md'
const ISSUE_ROWS = [
  '│ docs/reports/generated-weekly-summary-of-open │ Items still open after review  │',
  '│ -items.md (draft)                             │ and their current owners       │'
]

function fileLinksAt(rows: readonly string[], lineNumber: number, needle: string) {
  const lines = rows.map((text) => makeBufferLine(text))
  const x = rows[lineNumber - 1].indexOf(needle) + 1
  return findTerminalFileLinksAtBufferPosition(
    { getLine: (y) => lines[y] },
    { x, y: lineNumber },
    Math.max(...rows.map((row) => row.length))
  ).links.map(({ pathText, line, column }) => ({ pathText, line, column }))
}

function framedRow(cells: readonly string[], widths: readonly number[], vertical = '│'): string {
  return `${vertical}${cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(vertical)}${vertical}`
}

describe('file paths wrapped inside terminal table cells', () => {
  it.each([
    { name: 'box-drawing borders', rows: ISSUE_ROWS },
    { name: 'ASCII borders', rows: ISSUE_ROWS.map((row) => row.replaceAll('│', '|')) }
  ])('rebuilds a path wrapped across $name when either row is clicked', ({ rows }) => {
    const reading = { pathText: WRAPPED_PATH, line: null, column: null }

    expect(fileLinksAt(rows, 1, 'docs/reports')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, '-items.md')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, '(draft)').map((link) => link.pathText)).not.toContain(WRAPPED_PATH)
    expect(fileLinksAt(rows, 1, 'Items still').map((link) => link.pathText)).not.toContain(
      WRAPPED_PATH
    )
    expect(fileLinksAt(rows, 2, 'and their').map((link) => link.pathText)).not.toContain(
      WRAPPED_PATH
    )
  })

  it('rebuilds a wrapped path from the third row of a multi-column cell', () => {
    const widths = [45, 12]
    const rows = [
      framedRow([' docs/reports/generated-weekly-summary-of-ope', ' notes '], widths),
      framedRow([' n-items-and-notes-that-continue-across-ro', ' more '], widths),
      framedRow([' ws.md', ' later '], widths)
    ]

    const reading = {
      pathText:
        'docs/reports/generated-weekly-summary-of-open-items-and-notes-that-continue-across-rows.md',
      line: null,
      column: null
    }
    expect(fileLinksAt(rows, 1, 'docs/reports')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'n-items-and-notes')).toContainEqual(reading)
    expect(fileLinksAt(rows, 3, 'ws.md')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'more').map((link) => link.pathText)).not.toContain(
      reading.pathText
    )
  })

  it('keeps a :line:col suffix that wraps onto the next cell row', () => {
    const head = ' src/components/terminal/very-long-file-name.t'
    const widths = [head.length, 8]
    const rows = [framedRow([head, ' notes '], widths), framedRow([' s:42:10', ' more '], widths)]

    const reading = {
      pathText: 'src/components/terminal/very-long-file-name.ts',
      line: 42,
      column: 10
    }
    expect(fileLinksAt(rows, 1, 'src/components')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 's:42:10')).toContainEqual(reading)
  })

  it('joins .ts when a dotted basename reaches the cell border', () => {
    const head = ' src/components/widget.test'
    const widths = [head.length, 8]
    const rows = [framedRow([head, ' notes '], widths), framedRow([' .ts', ' more '], widths)]

    const reading = { pathText: 'src/components/widget.test.ts', line: null, column: null }
    expect(fileLinksAt(rows, 1, 'src/components')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, '.ts')).toContainEqual(reading)
  })

  it('joins a markdown extension split on a full cell', () => {
    const head = ' docs/guide.mark'
    const widths = [head.length, 8]
    const rows = [framedRow([head, ' notes '], widths), framedRow([' down', ' more '], widths)]

    const reading = { pathText: 'docs/guide.markdown', line: null, column: null }
    expect(fileLinksAt(rows, 1, 'docs/guide')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'down')).toContainEqual(reading)
  })

  it('keeps :line:col after a dotted basename that reaches the cell border', () => {
    const head = ' src/components/widget.test'
    const widths = [head.length, 8]
    const rows = [framedRow([head, ' notes '], widths), framedRow([' :42:10', ' more '], widths)]

    const reading = { pathText: 'src/components/widget.test', line: 42, column: 10 }
    expect(fileLinksAt(rows, 1, 'widget.test')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, ':42:10')).toContainEqual(reading)
  })

  it('stops a wrapped cell at a horizontal rule', () => {
    const widths = [45, 8]
    const wrapped =
      'docs/reports/generated-weekly-summary-of-open-items-and-more-text-until-the-border-end'
    const rows = [
      framedRow([' docs/reports/generated-weekly-summary-of-ope', ' notes'], widths),
      framedRow([' n-items-and-more-text-until-the-border-end', ' more'], widths),
      `├${'─'.repeat(widths[0])}┼${'─'.repeat(widths[1])}┤`,
      framedRow([' more.md', ' later'], widths)
    ]

    expect(fileLinksAt(rows, 1, 'docs/reports')).toContainEqual({
      pathText: wrapped,
      line: null,
      column: null
    })
    expect(fileLinksAt(rows, 2, 'n-items-and-more')).toContainEqual({
      pathText: wrapped,
      line: null,
      column: null
    })
    expect(
      fileLinksAt(rows, 1, 'docs/reports').some((link) => link.pathText.includes('more.md'))
    ).toBe(false)
    expect(fileLinksAt(rows, 4, 'more.md').map((link) => link.pathText)).not.toContain(wrapped)
  })

  it('does not join a finished filename onto the next row in the same column', () => {
    const file = ' src/components/terminal-pane.tsx '
    const widths = [file.length, 12]
    const rows = [
      framedRow([file, ' notes '], widths),
      framedRow([' README.md ', ' done '], widths)
    ]

    expect(fileLinksAt(rows, 1, 'src/components')).toEqual([
      { pathText: 'src/components/terminal-pane.tsx', line: null, column: null }
    ])
    expect(fileLinksAt(rows, 2, 'README.md').map((link) => link.pathText)).not.toContain(
      'src/components/terminal-pane.tsxREADME.md'
    )

    const pairRows = ['│ src/foo.ts │ notes │', '│ src/bar.ts │ more  │']
    expect(fileLinksAt(pairRows, 1, 'src/foo.ts')).toEqual([
      { pathText: 'src/foo.ts', line: null, column: null }
    ])
    expect(fileLinksAt(pairRows, 2, 'src/bar.ts')).toEqual([
      { pathText: 'src/bar.ts', line: null, column: null }
    ])

    const flagRows = ['│ src/foo.ts │ notes │', '│ -v         │ more  │']
    expect(fileLinksAt(flagRows, 1, 'src/foo.ts')).toEqual([
      { pathText: 'src/foo.ts', line: null, column: null }
    ])
    expect(fileLinksAt(flagRows, 2, '-v')).toEqual([])

    const mapRows = ['│ src/app.ts │ notes │', '│ .map       │ more  │']
    expect(fileLinksAt(mapRows, 1, 'src/app.ts')).toEqual([
      { pathText: 'src/app.ts', line: null, column: null }
    ])
    expect(fileLinksAt(mapRows, 2, '.map')).toEqual([])

    const paddedFile = ' src/foo.ts '
    const noteRows = [
      framedRow([paddedFile, ' notes '], [paddedFile.length, 7]),
      framedRow([' notes ', ' more '], [paddedFile.length, 7])
    ]
    expect(fileLinksAt(noteRows, 1, 'src/foo.ts')).toEqual([
      { pathText: 'src/foo.ts', line: null, column: null }
    ])
    expect(fileLinksAt(noteRows, 2, 'notes')).toEqual([])

    const paddedExtension = ' src/components/widget.test '
    const paddedExtensionRows = [
      framedRow([paddedExtension, ' notes '], [paddedExtension.length, 8]),
      framedRow([' .ts ', ' more '], [paddedExtension.length, 8])
    ]
    expect(fileLinksAt(paddedExtensionRows, 1, 'widget.test')).toEqual([
      { pathText: 'src/components/widget.test', line: null, column: null }
    ])
    expect(fileLinksAt(paddedExtensionRows, 2, '.ts')).toEqual([])
  })

  it('does not join a border-hugging filename onto the next row', () => {
    const head = ' src/foo.ts'
    const widths = [head.length, 8]
    const pathRows = [
      framedRow([head, ' notes '], widths),
      framedRow([' src/bar.ts', ' more '], widths)
    ]
    expect(fileLinksAt(pathRows, 1, 'src/foo.ts')).toEqual([
      { pathText: 'src/foo.ts', line: null, column: null }
    ])
    expect(fileLinksAt(pathRows, 2, 'src/bar.ts')).toEqual([
      { pathText: 'src/bar.ts', line: null, column: null }
    ])

    const proseRows = [
      framedRow([head, ' notes '], widths),
      framedRow([' nextword', ' later '], widths)
    ]
    expect(fileLinksAt(proseRows, 1, 'src/foo.ts')).toEqual([
      { pathText: 'src/foo.ts', line: null, column: null }
    ])
    expect(fileLinksAt(proseRows, 2, 'nextword')).toEqual([])

    const shortWordRows = [
      framedRow([head, ' notes '], widths),
      framedRow([' more', ' later '], widths)
    ]
    expect(fileLinksAt(shortWordRows, 1, 'src/foo.ts')).toEqual([
      { pathText: 'src/foo.ts', line: null, column: null }
    ])
    expect(fileLinksAt(shortWordRows, 2, 'more')).toEqual([])

    const longHead = ' src/components/foo.ts'
    const longWidths = [longHead.length, 8]
    const descriptionRows = [
      framedRow([longHead, ' notes '], longWidths),
      framedRow([' description', ' later '], longWidths)
    ]
    expect(fileLinksAt(descriptionRows, 1, 'src/components')).toEqual([
      { pathText: 'src/components/foo.ts', line: null, column: null }
    ])
    expect(fileLinksAt(descriptionRows, 2, 'description')).toEqual([])
  })

  it('keeps a short table cell and an unframed path on one row', () => {
    expect(
      fileLinksAt(
        [
          '│ src/foo.ts:42:10                    │ notes │',
          '│ README.md                           │ done  │'
        ],
        1,
        'src/foo.ts'
      )
    ).toEqual([{ pathText: 'src/foo.ts', line: 42, column: 10 }])

    expect(fileLinksAt(['read src/foo.ts today'], 1, 'src/foo.ts')).toContainEqual({
      pathText: 'src/foo.ts',
      line: null,
      column: null
    })
  })

  it('still joins a hard-wrapped path that is not inside a table', () => {
    const rows = [
      'result validation-screenshots/02-after-',
      'transparent-terminal-scrollbar-gutter.png next'
    ]
    const reading = {
      pathText: 'validation-screenshots/02-after-transparent-terminal-scrollbar-gutter.png',
      line: null,
      column: null
    }

    expect(fileLinksAt(rows, 1, 'validation-screenshots')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'transparent-terminal')).toContainEqual(reading)
  })
})
