import { beforeEach, expect, it, vi } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import { createPierreEditor, withPierreDiffEditState } from './pierre-diff-edit-state'

const { states, clear, get, nativeViews } = vi.hoisted(() => {
  const states = new Map<string, unknown>()
  const nativeViews = new Map<string, { selection?: { side: string } }>()
  return {
    states,
    nativeViews,
    get: vi.fn((_: string, key: string) => states.get(key)),
    clear: vi.fn((_: string, key: string) => states.delete(key))
  }
})
vi.mock('./pierre-diff-native-view-state', () => ({
  getPierreNativeView: (key: string) => nativeViews.get(key)
}))
vi.mock('@pierre/diffs/edit', () => ({
  EditStateManager: { get, clear },
  Editor: class {
    constructor(
      public type: string,
      public options: { onComplete?: (event: unknown) => void },
      public key?: string
    ) {}
    edit() {
      return () => this.options.onComplete?.({})
    }
  }
}))

function stored(original = 'old\n', modified = 'new\n') {
  return {
    type: 'file-diff',
    document: { getText: () => modified, history: { undoStack: [], redoStack: [] } },
    diffSession: { type: 'change', oldFile: { lines: [original] } }
  }
}
function create(scope: string, original = 'old\n', modified = 'new\n') {
  const diff = {
    type: 'change',
    deletionLines: [original],
    additionLines: [modified]
  } as FileDiffMetadata
  const editor = createPierreEditor('file-diff', withPierreDiffEditState({}, scope, diff))
  return {
    key: (editor as unknown as { key: string }).key,
    initialState: (
      editor as unknown as {
        options: { initialState?: { document?: unknown; diffSession?: unknown } }
      }
    ).options.initialState,
    finish: editor.edit({} as never)
  }
}

beforeEach(() => {
  states.clear()
  nativeViews.clear()
  vi.clearAllMocks()
})

it('reuses matching dormant document history and view state', () => {
  const state = stored()
  states.set('same', state)
  const editor = create('same')
  expect(clear).not.toHaveBeenCalled()
  expect(editor.key).toBe('same')
  expect(states.get('same')).toBe(state)
  expect(editor.initialState?.document).toBe(state.document)
  // Pierre resumes an edited document only from a complete EditState; keeping diffSession is
  // what lets it restore the selection rather than rebuilding and dropping it.
  expect(editor.initialState?.diffSession).toBe(state.diffSession)
  editor.finish()
})

it('yields selection restore to the native layer for a deletions-side selection', () => {
  const state = stored()
  states.set('native-owned', state)
  nativeViews.set('native-owned', { selection: { side: 'deletions' } })
  const editor = create('native-owned')
  // Only one layer may drive selection, so the editor gets a rebuilt session here.
  expect(editor.initialState?.document).toBe(state.document)
  expect(editor.initialState?.diffSession).toBeUndefined()
  editor.finish()
})

it('drops stale cached text without replaying it over an external update', () => {
  states.set('changed-text', stored())
  create('changed-text', 'old\n', 'external update\n').finish()
  expect(clear).toHaveBeenCalledWith('file-diff', 'changed-text')
})

it('preserves document history when only the comparison base changed', () => {
  states.set('changed-base', stored())
  create('changed-base', 'different base\n').finish()
  expect(clear).not.toHaveBeenCalledWith('file-diff', 'changed-base')
})

it('keeps simultaneous copies of a scope independent', () => {
  const first = create('parallel')
  const second = create('parallel')
  expect(second.key).not.toBe(first.key)
  second.finish()
  expect(clear).toHaveBeenCalledWith('file-diff', second.key)
  first.finish()
  const reopened = create('parallel')
  expect(reopened.key).toBe('parallel')
  reopened.finish()
})

it('evicts dormant document history when retained text exceeds the budget', () => {
  const editor = create('oversized-history')
  const state = stored()
  state.document.history.undoStack = [
    { forwardEdits: [], inverseEdits: [{ text: 'x'.repeat(16_000_001) }] }
  ] as never
  states.set(editor.key, state)
  editor.finish()
  expect(clear).toHaveBeenCalledWith('file-diff', editor.key)
  expect(states.has(editor.key)).toBe(false)
})
