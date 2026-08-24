import { describe, expect, it } from 'vitest'
import {
  fileUriToPath,
  lspCompletionToMonaco,
  lspDefinitionToLocations,
  lspDiagnosticsToMonacoMarkers,
  lspHoverToMonaco,
  lspPullDiagnosticsToItems,
  lspRangeToMonaco,
  toLspPosition
} from './lsp-monaco-conversion'

const lspRange = { start: { line: 0, character: 4 }, end: { line: 2, character: 0 } }
const monacoRange = { startLineNumber: 1, startColumn: 5, endLineNumber: 3, endColumn: 1 }

describe('position and range mapping', () => {
  it('shifts Monaco 1-based positions to LSP 0-based', () => {
    expect(toLspPosition({ lineNumber: 10, column: 3 })).toEqual({ line: 9, character: 2 })
  })

  it('shifts LSP ranges to Monaco ranges', () => {
    expect(lspRangeToMonaco(lspRange)).toEqual(monacoRange)
  })
})

describe('lspHoverToMonaco', () => {
  it('handles MarkupContent', () => {
    expect(lspHoverToMonaco({ contents: { kind: 'markdown', value: '**doc**' } })).toEqual({
      contents: [{ value: '**doc**' }]
    })
  })

  it('fences language-tagged MarkedStrings and keeps the range', () => {
    expect(
      lspHoverToMonaco({
        contents: [{ language: 'typescript', value: 'const x: number' }, 'extra'],
        range: lspRange
      })
    ).toEqual({
      contents: [{ value: '```typescript\nconst x: number\n```' }, { value: 'extra' }],
      range: monacoRange
    })
  })

  it('returns null for empty hovers', () => {
    expect(lspHoverToMonaco(null)).toBeNull()
    expect(lspHoverToMonaco({ contents: [] })).toBeNull()
    expect(lspHoverToMonaco({ contents: '   ' })).toBeNull()
  })
})

describe('lspDefinitionToLocations', () => {
  it('normalizes single Location, Location[], and LocationLink[]', () => {
    const location = { uri: 'file:///a.ts', range: lspRange }
    expect(lspDefinitionToLocations(location)).toEqual([
      { uri: 'file:///a.ts', range: monacoRange }
    ])
    expect(lspDefinitionToLocations([location])).toHaveLength(1)
    expect(
      lspDefinitionToLocations([
        {
          targetUri: 'file:///b.ts',
          targetRange: { start: { line: 5, character: 0 }, end: { line: 9, character: 0 } },
          targetSelectionRange: lspRange
        }
      ])
    ).toEqual([{ uri: 'file:///b.ts', range: monacoRange }])
    expect(lspDefinitionToLocations(null)).toEqual([])
  })
})

describe('lspCompletionToMonaco', () => {
  const enums = { kinds: { Text: 18, Function: 1, Method: 0 }, snippetRule: 4 }
  const defaultRange = monacoRange

  it('maps LSP kinds to the provided Monaco kind enum', () => {
    const { suggestions } = lspCompletionToMonaco(
      { isIncomplete: true, items: [{ label: 'fn', kind: 3 }] },
      defaultRange,
      enums
    )
    expect(suggestions).toEqual([{ label: 'fn', kind: 1, insertText: 'fn', range: defaultRange }])
  })

  it('prefers textEdit newText and range, and flags snippets', () => {
    const { suggestions, incomplete } = lspCompletionToMonaco(
      {
        isIncomplete: true,
        items: [
          {
            label: 'log',
            kind: 2,
            insertText: 'ignored',
            insertTextFormat: 2,
            textEdit: { newText: 'log($1)', range: lspRange }
          }
        ]
      },
      defaultRange,
      enums
    )
    expect(incomplete).toBe(true)
    expect(suggestions[0]).toMatchObject({
      insertText: 'log($1)',
      insertTextRules: 4,
      range: monacoRange,
      kind: 0
    })
  })

  it('accepts a bare CompletionItem[] response', () => {
    const { suggestions, incomplete } = lspCompletionToMonaco([{ label: 'a' }], defaultRange, enums)
    expect(incomplete).toBe(false)
    expect(suggestions[0].kind).toBe(18)
  })
})

describe('lspDiagnosticsToMonacoMarkers', () => {
  const severities = { Error: 8, Warning: 4, Info: 2, Hint: 1 }

  it('maps severity, code objects, and range', () => {
    const markers = lspDiagnosticsToMonacoMarkers(
      [
        { range: lspRange, message: 'bad', severity: 2, code: { value: 2304 }, source: 'ts' },
        { range: lspRange, message: 'unknown severity defaults to error' }
      ],
      severities
    )
    expect(markers[0]).toEqual({
      ...monacoRange,
      severity: 4,
      message: 'bad',
      code: '2304',
      source: 'ts'
    })
    expect(markers[1].severity).toBe(8)
  })

  it('drops malformed entries', () => {
    expect(
      lspDiagnosticsToMonacoMarkers(
        [null, { message: 'no range' }, { range: lspRange }],
        severities
      )
    ).toEqual([])
  })
})

describe('lspPullDiagnosticsToItems', () => {
  it('returns items for full reports and null otherwise', () => {
    const items = [{ range: lspRange, message: 'bad' }]
    expect(lspPullDiagnosticsToItems({ kind: 'full', items })).toBe(items)
    expect(lspPullDiagnosticsToItems({ kind: 'unchanged', resultId: 'a' })).toBeNull()
    expect(lspPullDiagnosticsToItems(null)).toBeNull()
    expect(lspPullDiagnosticsToItems({ kind: 'full' })).toBeNull()
  })
})

describe('fileUriToPath', () => {
  it('decodes posix paths', () => {
    expect(fileUriToPath('file:///Users/dev/my%20project/a.ts')).toBe('/Users/dev/my project/a.ts')
  })

  it('converts drive-letter URIs to Windows paths', () => {
    expect(fileUriToPath('file:///C:/dev/repo/a.ts')).toBe('C:\\dev\\repo\\a.ts')
    expect(fileUriToPath('file:///c%3A/dev/a.ts')).toBe('c:\\dev\\a.ts')
  })

  it('rejects non-file and remote-host URIs', () => {
    expect(fileUriToPath('untitled:Untitled-1')).toBeNull()
    expect(fileUriToPath('file://server/share/a.ts')).toBeNull()
    expect(fileUriToPath('file://localhost/a.ts')).toBe('/a.ts')
  })
})
