// @vitest-environment happy-dom
// Perf contract (#48668, blame column): each edit remapped the whole buffer onto HEAD (up to 50 ms) from
// the line-number repaint, and the edited line kept its old commit's tooltip until a delayed rebuild.
// Typing runs no blame lookup and leaves no stale tooltip; blame comes back once the editor pauses.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitBlameCommit } from '../../../../../shared/git/blame/git-blame-types'
import { createBlameColumn } from './monaco-blame-column'
import type { LineBlame } from './git-blame-line-store'

const COMMITS: Record<string, GitBlameCommit> = {
  a: { oid: 'a'.repeat(40), author: 'Ada', authorEmail: '', authorTime: 1_000, summary: 'alpha' },
  b: { oid: 'b'.repeat(40), author: 'Bob', authorEmail: '', authorTime: 2_000, summary: 'beta' }
}
const LOADED = { blame: { commits: Object.values(COMMITS) } }

// Stands in for the HEAD mapping: lines still reading `a…` or `b…` come from that commit.
function blameOfText(text: string): LineBlame {
  const commit = COMMITS[text[0]]
  return commit ? { kind: 'commit', commit } : { kind: 'uncommitted' }
}

let model: monaco.editor.ITextModel
let lookups = 0
let painted: string[] = []

// Just enough of Monaco's editor: it repaints the line numbers on an option change, as Monaco does.
function createEditorDouble(): monaco.editor.IStandaloneCodeEditor {
  let renderer: ((lineNumber: number) => string) | null = null
  let rawLineNumbers: unknown = 'on'
  const configListeners: (() => void)[] = []
  const double = {
    getModel: () => model,
    getRawOptions: () => ({ lineNumbers: rawLineNumbers }),
    updateOptions: (options: { lineNumbers?: unknown }) => {
      if (!('lineNumbers' in options)) {
        return
      }
      rawLineNumbers = options.lineNumbers
      renderer =
        typeof options.lineNumbers === 'function'
          ? (options.lineNumbers as (lineNumber: number) => string)
          : null
      paint()
      configListeners.forEach((listener) => listener())
    },
    onDidChangeConfiguration: (listener: () => void) => {
      configListeners.push(listener)
      return { dispose: () => configListeners.splice(configListeners.indexOf(listener), 1) }
    },
    createDecorationsCollection: () => {
      let ids: string[] = []
      return {
        set: (decorations: monaco.editor.IModelDeltaDecoration[]) =>
          (ids = model.deltaDecorations(ids, decorations)),
        clear: () => {
          ids = model.deltaDecorations(ids, [])
        }
      }
    },
    paint: () => paint()
  }
  const paint = (): void => {
    painted = Array.from({ length: model.getLineCount() }, (_, index) =>
      renderer ? renderer(index + 1) : String(index + 1)
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column only reads the model, options, config events and decorations, all provided here.
  return double as unknown as monaco.editor.IStandaloneCodeEditor
}

function mountColumn(): { type: (lineNumber: number) => void; tooltips: () => string[] } {
  model = monaco.editor.createModel('a1\na2\nb3\nb4', 'plaintext')
  const ed = createEditorDouble()
  const column = createBlameColumn(ed, {
    loaded: () => LOADED,
    lineBlameAt: (lineNumber) => {
      lookups += 1
      return blameOfText(model.getLineContent(lineNumber))
    }
  })
  column.sync()
  lookups = 0
  return {
    // A keystroke: the edit, the editor's own change listener, then Monaco's repaint.
    type: (lineNumber) => {
      model.applyEdits([{ range: new monaco.Range(lineNumber, 1, lineNumber, 1), text: 'x' }])
      column.sync()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double adds `paint`.
      ;(ed as unknown as { paint: () => void }).paint()
    },
    // `first-last:Author` for every tooltip on the model.
    tooltips: () =>
      model
        .getAllDecorations()
        .filter((decoration) => decoration.options.lineNumberHoverMessage)
        .map((decoration) => {
          const { value } = decoration.options.lineNumberHoverMessage as monaco.IMarkdownString
          const author = /^\*\*(\w+)\*\*/.exec(value)?.[1]
          return `${decoration.range.startLineNumber}-${decoration.range.endLineNumber}:${author}`
        })
        .sort()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  lookups = 0
  painted = []
})

afterEach(() => {
  vi.useRealTimers()
  model.dispose()
})

it('runs no blame lookup while typing and draws blame again after the pause', () => {
  const { type } = mountColumn()

  for (let key = 0; key < 5; key++) {
    type(2)
    vi.advanceTimersByTime(40)
  }

  expect(lookups).toBe(0)
  expect(painted[1]).toBe('2')

  vi.advanceTimersByTime(250)

  expect(painted[0]).toContain('Ada')
  expect(painted[1]).toContain('Uncommitted changes')
})

it('drops the edited line from its old commit tooltip at once and regroups after the pause', () => {
  const { type, tooltips } = mountColumn()
  expect(tooltips()).toEqual(['1-2:Ada', '3-4:Bob'])

  type(2)

  expect(tooltips()).toEqual([])

  vi.advanceTimersByTime(250)

  expect(tooltips()).toEqual(['1-1:Ada', '3-4:Bob'])
})
