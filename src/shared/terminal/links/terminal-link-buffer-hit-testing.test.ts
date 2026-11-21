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

function charColumns(text: string): number[] {
  const columns: number[] = []
  let col = 0
  for (let index = 0; index < text.length; index++) {
    columns.push(col)
    col += text[index] === '\u3000' ? 2 : 1
  }
  columns.push(col)
  return columns
}

function makeBufferLine(text: string): TestBufferLine {
  const columns = charColumns(text)
  const totalWidth = columns[text.length] ?? text.length
  return {
    isWrapped: false,
    length: totalWidth,
    getCell: () => undefined,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = totalWidth,
      outColumns?: number[]
    ) => {
      let result = ''
      if (outColumns) {
        outColumns.length = 0
      }
      for (let index = 0; index < text.length; index++) {
        const col = columns[index] ?? index
        if (col < startColumn || col >= endColumn) {
          continue
        }
        result += text[index] ?? ''
        outColumns?.push(col)
      }
      if (outColumns) {
        const lastCol =
          result.length > 0
            ? (columns[text.length] ?? totalWidth)
            : Math.min(startColumn, totalWidth)
        outColumns.push(Math.min(endColumn, lastCol))
      }
      return result
    }
  }
}

const WRAPPED_PATH = 'docs/reports/generated-weekly-summary-of-open-items.md'
const ISSUE_ROWS = [
  '│ docs/reports/generated-weekly-summary-of-open │ Items still open after review  │',
  '│ -items.md (draft)                             │ and their current owners       │'
]

function fileLinksAt(rows: readonly string[], lineNumber: number, needle: string, occurrence = 1) {
  const line = rows[lineNumber - 1] ?? ''
  let from = 0
  let index = -1
  for (let count = 0; count < occurrence; count++) {
    index = line.indexOf(needle, from)
    if (index < 0) {
      break
    }
    from = index + 1
  }
  if (index < 0) {
    throw new Error(
      `needle ${JSON.stringify(needle)} occurrence ${occurrence} missing on line ${lineNumber}`
    )
  }
  const lines = rows.map((text) => makeBufferLine(text))
  const lineCols = charColumns(line)
  return findTerminalFileLinksAtBufferPosition(
    { getLine: (y) => lines[y] },
    { x: (lineCols[index] ?? index) + 1, y: lineNumber },
    Math.max(...lines.map((entry) => entry.length))
  ).links.map(({ pathText, line: linkLine, column }) => ({
    pathText,
    line: linkLine,
    column
  }))
}

function framedRow(cells: readonly string[], widths: readonly number[], vertical = '│'): string {
  return `${vertical}${cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(vertical)}${vertical}`
}

function unpaddedRows(head: string, next: string): string[] {
  const widths = [head.length, 8]
  return [framedRow([head, ' notes '], widths), framedRow([next, ' more '], widths)]
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

  it('keeps a repeated wrapped path clickable in each cell of the same row', () => {
    const head = ' src/components/very-long-widget-name/'
    const widths = [head.length, head.length]
    const rows = [framedRow([head, head], widths), framedRow([' file.ts', ' file.ts'], widths)]
    const reading = {
      pathText: 'src/components/very-long-widget-name/file.ts',
      line: null,
      column: null
    }

    expect(fileLinksAt(rows, 1, 'src/components')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'file.ts')).toContainEqual(reading)
    expect(fileLinksAt(rows, 1, 'src/components', 2)).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'file.ts', 2)).toContainEqual(reading)
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

  it.each([
    {
      head: ' src/components/widget.spec',
      next: ' .tsx',
      pathText: 'src/components/widget.spec.tsx',
      line: null,
      column: null,
      headNeedle: 'widget.spec',
      nextNeedle: '.tsx'
    },
    {
      head: ' dist/archive.tar',
      next: ' .gz',
      pathText: 'dist/archive.tar.gz',
      line: null,
      column: null,
      headNeedle: 'archive.tar',
      nextNeedle: '.gz'
    },
    {
      head: ' src/types/index.d',
      next: ' .ts',
      pathText: 'src/types/index.d.ts',
      line: null,
      column: null,
      headNeedle: 'index.d',
      nextNeedle: '.ts'
    },
    {
      head: ' src/components/button.min',
      next: ' .js',
      pathText: 'src/components/button.min.js',
      line: null,
      column: null,
      headNeedle: 'button.min',
      nextNeedle: '.js'
    },
    {
      head: ' src/styles/widget.module',
      next: ' .css',
      pathText: 'src/styles/widget.module.css',
      line: null,
      column: null,
      headNeedle: 'widget.module',
      nextNeedle: '.css'
    },
    {
      head: ' src/components/widget.stories',
      next: ' .tsx',
      pathText: 'src/components/widget.stories.tsx',
      line: null,
      column: null,
      headNeedle: 'widget.stories',
      nextNeedle: '.tsx'
    },
    {
      head: ' src/components/widget.test',
      next: ' .ts:42:10',
      pathText: 'src/components/widget.test.ts',
      line: 42,
      column: 10,
      headNeedle: 'widget.test',
      nextNeedle: '.ts:42:10'
    },
    {
      head: ' src/components/WIDGET.TEST',
      next: ' .TS',
      pathText: 'src/components/WIDGET.TEST.TS',
      line: null,
      column: null,
      headNeedle: 'WIDGET.TEST',
      nextNeedle: '.TS'
    },
    {
      head: ' dist/Archive.TAR',
      next: ' .GZ',
      pathText: 'dist/Archive.TAR.GZ',
      line: null,
      column: null,
      headNeedle: 'Archive.TAR',
      nextNeedle: '.GZ'
    },
    {
      head: ' src/components/widget.stories',
      next: ' .svelte',
      pathText: 'src/components/widget.stories.svelte',
      line: null,
      column: null,
      headNeedle: 'widget.stories',
      nextNeedle: '.svelte'
    }
  ])(
    'joins a compound extension cut at the border ($pathText)',
    ({ head, next, pathText, line, column, headNeedle, nextNeedle }) => {
      const rows = unpaddedRows(head, next)
      const reading = { pathText, line, column }
      expect(fileLinksAt(rows, 1, headNeedle)).toContainEqual(reading)
      expect(fileLinksAt(rows, 2, nextNeedle)).toContainEqual(reading)
    }
  )

  it('joins a source map split inside the extension at the cell border', () => {
    const rows = unpaddedRows(' src/widget.ts.m', ' ap')
    const reading = { pathText: 'src/widget.ts.map', line: null, column: null }
    expect(fileLinksAt(rows, 1, 'widget.ts')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'ap')).toContainEqual(reading)
  })

  it('joins a source map whose dot stays on the first row', () => {
    const rows = unpaddedRows(' src/widget.ts.', ' map')
    const reading = { pathText: 'src/widget.ts.map', line: null, column: null }
    expect(fileLinksAt(rows, 1, 'widget.ts')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'map')).toContainEqual(reading)
  })

  it.each([
    { path: 'src/widget.ts', next: '.gitignore' },
    { path: 'src/widget.ts', next: '.env' },
    { path: 'src/widget.ts', next: '.npmrc' },
    { path: 'src/widget.ts', next: '.eslintrc' },
    { path: 'src/widget.ts', next: '.bak' },
    { path: 'src/widget.ts', next: '.map' },
    { path: 'src/widget.ts', next: '.git' },
    { path: '\\\\server\\share\\src\\widget.ts', next: '.gitignore' },
    { path: 'dist/archive.tar', next: '.env' },
    { path: 'dist/archive.tar', next: '.git' },
    { path: 'dist/archive.tar', next: '.gitignore' },
    { path: 'dist/archive.tar', next: '.bak' },
    { path: 'dist/archive.tar', next: '.map' },
    { path: '\\\\server\\share\\dist\\archive.tar', next: '.bak' },
    { path: 'src/components/widget.test', next: '.gitignore' },
    { path: 'src/components/widget.test', next: '.bak' },
    { path: 'src/main.d', next: '.md' },
    { path: 'src/button.min', next: '.map' },
    { path: 'src/main.c', next: '.h' }
  ])('does not join $next onto $path in an unpadded cell', ({ path, next }) => {
    const rows = unpaddedRows(` ${path}`, ` ${next}`)
    expect(fileLinksAt(rows, 1, path)).toEqual([{ pathText: path, line: null, column: null }])
    expect(fileLinksAt(rows, 2, next)).toEqual([])
  })

  it('joins a markdown extension split on a full cell', () => {
    const head = ' docs/guide.mark'
    const widths = [head.length, 8]
    const rows = [framedRow([head, ' notes '], widths), framedRow([' down', ' more '], widths)]

    const reading = { pathText: 'docs/guide.markdown', line: null, column: null }
    expect(fileLinksAt(rows, 1, 'docs/guide')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'down')).toContainEqual(reading)

    const upperRows = unpaddedRows(' docs/guide.MARK', ' down')
    const upperReading = { pathText: 'docs/guide.MARKdown', line: null, column: null }
    expect(fileLinksAt(upperRows, 1, 'docs/guide')).toContainEqual(upperReading)
    expect(fileLinksAt(upperRows, 2, 'down')).toContainEqual(upperReading)
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

  it('joins a punctuation-only final fragment that completes a wrapped table path', () => {
    const paddedRows = ['│ src/generated/ │ notes │', '│ __             │ more  │']
    const reading = { pathText: 'src/generated/__', line: null, column: null }
    expect(fileLinksAt(paddedRows, 1, 'src/generated/')).toContainEqual(reading)
    expect(fileLinksAt(paddedRows, 2, '__')).toContainEqual(reading)

    const unpadded = unpaddedRows(' src/generated/', ' __')
    expect(fileLinksAt(unpadded, 1, 'src/generated/')).toContainEqual(reading)
    expect(fileLinksAt(unpadded, 2, '__')).toContainEqual(reading)

    const suffixRows = unpaddedRows(' src/generated/file_', ' _')
    const suffixReading = { pathText: 'src/generated/file__', line: null, column: null }
    expect(fileLinksAt(suffixRows, 1, 'src/generated/')).toContainEqual(suffixReading)
    expect(fileLinksAt(suffixRows, 2, '_')).toContainEqual(suffixReading)

    const tildeRows = unpaddedRows(' src/generated/file', ' ~')
    const tildeReading = { pathText: 'src/generated/file~', line: null, column: null }
    expect(fileLinksAt(tildeRows, 1, 'src/generated/')).toContainEqual(tildeReading)
    expect(fileLinksAt(tildeRows, 2, '~')).toContainEqual(tildeReading)

    const plusRows = unpaddedRows(' src/generated/lang/c', ' ++')
    const plusReading = { pathText: 'src/generated/lang/c++', line: null, column: null }
    expect(fileLinksAt(plusRows, 1, 'src/generated/')).toContainEqual(plusReading)
    expect(fileLinksAt(plusRows, 2, '++')).toContainEqual(plusReading)
  })

  it.each([
    '-',
    '--',
    '---',
    '--------------',
    ':------------:',
    ':---',
    '---:',
    '=',
    '===',
    '==============',
    '___',
    '______________',
    '~~',
    '~~~',
    '.',
    '..',
    '...',
    '+-+-+',
    '+---+',
    '+++',
    ':::',
    '///',
    ',',
    '_ _ _',
    '_ _ _.',
    '_ _ _,',
    '_ _ _ (draft)',
    '_ _;',
    '_ _!',
    '_, _',
    '_ , _',
    '_ . _',
    '_ - _',
    '__ __',
    '__  __',
    '__ __.',
    '__ __,',
    '__ __;',
    '__ __!',
    '__ __?',
    '__ __:',
    '__ __)',
    '__, __',
    '~ ~ ~',
    '~ ~ ~,',
    '~ ~;',
    '~ ~!',
    '~ , ~',
    '~ . ~',
    '+ + +',
    '+ + +,',
    '+ + +!',
    '+ + +;',
    '+ + +:',
    '+ + +)',
    '+ . + . +',
    '+ , + , +',
    '+ - +',
    '+ - + - +',
    '(_)',
    '[__]',
    '_:!'
  ])('does not join separator or rule fragment %j onto a wrapped table path', (separator) => {
    const rows = unpaddedRows(' src/generated/', ` ${separator}`)
    expect(
      fileLinksAt(rows, 1, 'src/generated/').some((link) => link.pathText !== 'src/generated/')
    ).toBe(false)
    expect(fileLinksAt(rows, 2, separator)).toEqual([])
  })

  it('keeps punctuation-only continuations followed by prose or ellipsis in the same cell', () => {
    for (const [next, tail] of [
      ['__ (draft)    ', '(draft)'],
      ['__ - generated', 'generated']
    ]) {
      const rows = ['│ src/generated/ │ notes │', `│ ${next} │ more  │`]
      const reading = { pathText: 'src/generated/__', line: null, column: null }
      expect(fileLinksAt(rows, 1, 'src/generated/')).toContainEqual(reading)
      expect(fileLinksAt(rows, 2, '__')).toContainEqual(reading)
      expect(fileLinksAt(rows, 2, tail)).toEqual([])
    }

    for (const [next, tail] of [
      [' ~ ...', '...'],
      [' ~...', '...'],
      [' ~;', ';']
    ]) {
      const tildeRows = unpaddedRows(' src/generated/file', next)
      const tildeReading = { pathText: 'src/generated/file~', line: null, column: null }
      expect(fileLinksAt(tildeRows, 1, 'src/generated/')).toContainEqual(tildeReading)
      expect(fileLinksAt(tildeRows, 2, '~')).toContainEqual(tildeReading)
      expect(fileLinksAt(tildeRows, 2, tail)).toEqual([])
    }

    for (const [next, tail, occurrence] of [
      [' ++ ...', '...', 1],
      [' ++...', '...', 1],
      [' ++ +', '+', 3],
      [' ++ - note', 'note', 1]
    ] as const) {
      const plusRows = unpaddedRows(' src/generated/lang/c', next)
      const plusReading = { pathText: 'src/generated/lang/c++', line: null, column: null }
      expect(fileLinksAt(plusRows, 1, 'src/generated/')).toContainEqual(plusReading)
      expect(fileLinksAt(plusRows, 2, '++')).toContainEqual(plusReading)
      expect(fileLinksAt(plusRows, 2, tail, occurrence)).toEqual([])
    }
  })

  it('does not join a punctuation-only fragment after a finished file extension', () => {
    const rows = unpaddedRows(' src/widget.ts', ' __')
    expect(fileLinksAt(rows, 1, 'src/widget.ts')).toEqual([
      { pathText: 'src/widget.ts', line: null, column: null }
    ])
    expect(fileLinksAt(rows, 2, '__')).toEqual([])
  })

  it('keeps an already-complete wrapped path when the next row could extend its extension', () => {
    const widths = [21, 8]
    const rows = [
      framedRow([' src/components/LongN', ' notes '], widths),
      framedRow([' ame-of-the-widget.ts', ' more  '], widths),
      framedRow([' x                   ', ' tail  '], widths)
    ]
    const tsReading = {
      pathText: 'src/components/LongName-of-the-widget.ts',
      line: null,
      column: null
    }
    const tsxReading = {
      pathText: 'src/components/LongName-of-the-widget.tsx',
      line: null,
      column: null
    }
    expect(fileLinksAt(rows, 1, 'src/components')).toContainEqual(tsReading)
    expect(fileLinksAt(rows, 1, 'src/components')).toContainEqual(tsxReading)
    expect(fileLinksAt(rows, 2, 'ame-of-the-widget.ts')).toContainEqual(tsReading)
  })

  it('does not slice mid-token when a continuation row is shifted left inside aligned borders', () => {
    const rows = ['│  src/long/│ notes │', '│ file.ts   │ more  │']
    expect(
      fileLinksAt(rows, 1, 'src/long/').some((link) => link.pathText === 'src/long/ile.ts')
    ).toBe(false)
    expect(fileLinksAt(rows, 2, 'file.ts')).not.toContainEqual({
      pathText: 'src/long/ile.ts',
      line: null,
      column: null
    })
  })

  it('rebuilds flush border-wrapped long extensions such as .swift', () => {
    const rows = unpaddedRows(' src/components/ProgressView.swi', ' ft')
    const reading = { pathText: 'src/components/ProgressView.swift', line: null, column: null }
    expect(fileLinksAt(rows, 1, 'src/components')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'ft')).toContainEqual(reading)
  })

  it('joins a path that fills the usable width of a padded narrow cell', () => {
    const reading = { pathText: 'src/a.ts', line: null, column: null }
    const singlePad = ['│ src/ │', '│ a.ts │']
    expect(fileLinksAt(singlePad, 1, 'src/')).toContainEqual(reading)
    expect(fileLinksAt(singlePad, 2, 'a.ts')).toContainEqual(reading)

    const doublePad = ['│  src/  │', '│  a.ts  │']
    expect(fileLinksAt(doublePad, 1, 'src/')).toContainEqual(reading)
    expect(fileLinksAt(doublePad, 2, 'a.ts')).toContainEqual(reading)

    // Full-width ideographic spaces (U+3000) occupy two terminal columns each.
    const wideSpacePad = ['│\u3000src/\u3000│', '│\u3000a.ts\u3000│']
    expect(fileLinksAt(wideSpacePad, 1, 'src/')).toContainEqual(reading)
    expect(fileLinksAt(wideSpacePad, 2, 'a.ts')).toContainEqual(reading)

    // U+3000 plus an ASCII space is 3 terminal columns (exceeding the 2-column padding cap)
    // even though it is only 2 UTF-16 code units.
    const threeColWideSpacePad = ['│\u3000 src/ \u3000│', '│\u3000 a.ts \u3000│']
    expect(fileLinksAt(threeColWideSpacePad, 1, 'src/').map((link) => link.pathText)).not.toContain(
      'src/a.ts'
    )
    expect(fileLinksAt(threeColWideSpacePad, 2, 'a.ts')).toEqual([
      { pathText: 'a.ts', line: null, column: null }
    ])
  })

  it('does not join centered or right-aligned table rows as hard wraps', () => {
    const centered = ['│     src/     │', '│     a.ts     │']
    expect(fileLinksAt(centered, 1, 'src/').map((link) => link.pathText)).not.toContain('src/a.ts')
    expect(fileLinksAt(centered, 2, 'a.ts')).toEqual([
      { pathText: 'a.ts', line: null, column: null }
    ])

    const rightAligned = ['│   src/foo/ │', '│   other.ts │']
    expect(fileLinksAt(rightAligned, 1, 'src/foo/').map((link) => link.pathText)).not.toContain(
      'src/foo/other.ts'
    )
    expect(fileLinksAt(rightAligned, 2, 'other.ts')).toEqual([
      { pathText: 'other.ts', line: null, column: null }
    ])

    const narrowRightAligned = ['│  src/foo/ │', '│  other.ts │']
    expect(
      fileLinksAt(narrowRightAligned, 1, 'src/foo/').map((link) => link.pathText)
    ).not.toContain('src/foo/other.ts')

    const labeledPrefix = ['│ A src/foo/ │', '│ B other.ts │']
    expect(fileLinksAt(labeledPrefix, 1, 'src/foo/').map((link) => link.pathText)).not.toContain(
      'src/foo/other.ts'
    )
    expect(fileLinksAt(labeledPrefix, 2, 'other.ts')).toEqual([
      { pathText: 'other.ts', line: null, column: null }
    ])

    // Flush single-column labels and a labeled continuation after a padded head must stay separate.
    const flushLabeledPrefix = ['│A src/foo/  │', '│B other.ts  │']
    expect(
      fileLinksAt(flushLabeledPrefix, 1, 'src/foo/').map((link) => link.pathText)
    ).not.toContain('src/foo/other.ts')
    expect(fileLinksAt(flushLabeledPrefix, 2, 'other.ts')).toEqual([
      { pathText: 'other.ts', line: null, column: null }
    ])

    const labeledContinuation = ['│  src/  │', '│B a.ts  │']
    expect(fileLinksAt(labeledContinuation, 1, 'src/').map((link) => link.pathText)).not.toContain(
      'src/a.ts'
    )
    expect(fileLinksAt(labeledContinuation, 2, 'a.ts')).toEqual([
      { pathText: 'a.ts', line: null, column: null }
    ])
  })

  it('does not join a short fragment that leaves unused width beside cell padding', () => {
    const narrowGap = ['│ a/   │', '│ b.ts │']
    expect(fileLinksAt(narrowGap, 1, 'a/').map((link) => link.pathText)).not.toContain('a/b.ts')
    expect(fileLinksAt(narrowGap, 2, 'b.ts')).toEqual([
      { pathText: 'b.ts', line: null, column: null }
    ])

    const wideGap = ['│ src/        │', '│ a.ts        │']
    expect(fileLinksAt(wideGap, 1, 'src/').map((link) => link.pathText)).not.toContain('src/a.ts')
    expect(fileLinksAt(wideGap, 2, 'a.ts')).toEqual([
      { pathText: 'a.ts', line: null, column: null }
    ])

    const separateFiles = ['│ foo.ts   │', '│ bar.ts   │']
    expect(fileLinksAt(separateFiles, 1, 'foo.ts')).toEqual([
      { pathText: 'foo.ts', line: null, column: null }
    ])
    expect(fileLinksAt(separateFiles, 2, 'bar.ts')).toEqual([
      { pathText: 'bar.ts', line: null, column: null }
    ])

    // One left space and a flush right border is not symmetric padding. The fragment is 3/4 of
    // the cell, under the fill ratio, so these rows stay separate.
    const flushNarrow = ['│ ab/│', '│ cd/│']
    expect(fileLinksAt(flushNarrow, 1, 'ab/').map((link) => link.pathText)).not.toContain('ab/cd/')
    expect(fileLinksAt(flushNarrow, 2, 'cd/').map((link) => link.pathText)).not.toContain('ab/cd/')
  })

  it('still joins a narrow path that is flush with the right border', () => {
    const rows = ['│ src/│', '│ a.ts│']
    const reading = { pathText: 'src/a.ts', line: null, column: null }
    expect(fileLinksAt(rows, 1, 'src/')).toContainEqual(reading)
    expect(fileLinksAt(rows, 2, 'a.ts')).toContainEqual(reading)
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
