// @vitest-environment happy-dom
// Perf contract (#48668, blame column): each edit remapped the whole buffer onto HEAD (up to 50 ms) from
// the line-number repaint and the tooltip regrouping. Typing runs no blame lookup; once the editor pauses,
// the column draws blame and regroups its tooltips with one lookup per line each.
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

// Just enough of Monaco's editor: it repaints the line numbers on an option change, as Monaco does.
function createEditorDouble(): monaco.editor.IStandaloneCodeEditor {
  let renderer: ((lineNumber: number) => string) | null = null
  let rawLineNumbers: unknown = 'on'
  const configListeners: (() => void)[] = []
  const double = {
    getModel: () => model,
    getRawOptions: () => ({ lineNumbers: rawLineNumbers }),
    updateOptions: (options: monaco.editor.IEditorOptions) => {
      if (!('lineNumbers' in options)) {
        return
      }
      rawLineNumbers = options.lineNumbers
      renderer = typeof options.lineNumbers === 'function' ? options.lineNumbers : null
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
    for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++) {
      renderer?.(lineNumber)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column only reads the model, options, config events and decorations, all provided here.
  return double as unknown as monaco.editor.IStandaloneCodeEditor
}

function mountColumn(): { type: (lineNumber: number) => void } {
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
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  lookups = 0
})

afterEach(() => {
  vi.useRealTimers()
  model.dispose()
})

it('runs no blame lookup while typing, then one per line to draw and one to regroup', () => {
  const { type } = mountColumn()

  for (let key = 0; key < 5; key++) {
    type(2)
    vi.advanceTimersByTime(40)
  }

  expect(lookups).toBe(0)

  vi.advanceTimersByTime(250)

  // 4 lines: 4 lookups to draw blame, 4 to regroup the tooltips.
  expect(lookups).toBe(8)
})
