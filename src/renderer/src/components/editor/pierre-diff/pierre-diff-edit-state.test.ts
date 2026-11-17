import { beforeEach, expect, it, vi } from 'vitest'
import { FileDiff, parseDiffFromFile } from '@pierre/diffs'
import type { PierreDiffAnnotationData } from './pierre-diff-comment-annotations'
import { createPierreEditor, withPierreDiffEditState } from './pierre-diff-edit-state'

const { states, clear, get, nativeViews, constructed } = vi.hoisted(() => {
  const states = new Map<string, unknown>()
  const nativeViews = new Map<string, { selection?: { side: string } }>()
  const constructed: {
    key?: string
    options: { initialState?: { document?: unknown; diffSession?: unknown } }
  }[] = []
  return {
    states,
    constructed,
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
      public options: {
        onComplete?: (event: unknown) => void
        initialState?: { document?: unknown; diffSession?: unknown }
      },
      public key?: string
    ) {
      constructed.push({ key, options })
    }
    edit() {
      return () => this.options.onComplete?.({})
    }
    cleanUp(_reason?: 'discard' | 'recycle' | 'complete') {}
  }
}))

function stored(original = 'old\n', modified = 'new\n') {
  const undoStack: { forwardEdits: { text: string }[]; inverseEdits: { text: string }[] }[] = []
  return {
    type: 'file-diff',
    document: { getText: () => modified, history: { undoStack, redoStack: [] } },
    diffSession: { type: 'change', oldFile: { name: 'file', lines: [original] } }
  }
}
function create(scope: string, original = 'old\n', modified = 'new\n') {
  const diff = parseDiffFromFile(
    { name: 'file', contents: original },
    { name: 'file', contents: modified }
  )
  const editor = createPierreEditor('file-diff', withPierreDiffEditState({}, scope, diff))
  const inspected = constructed.at(-1)
  if (!inspected?.key) {
    throw new Error('Expected the mocked Editor to be constructed with a state key')
  }
  return {
    key: inspected.key,
    initialState: inspected.options.initialState,
    finish: editor.edit(new FileDiff<PierreDiffAnnotationData>())
  }
}

beforeEach(() => {
  states.clear()
  nativeViews.clear()
  constructed.length = 0
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

it('yields selection restore to the native layer whenever it saved one', () => {
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

it('releases the scope when cleanup finishes without emitting complete', () => {
  const editor = createPierreEditor(
    'file-diff',
    withPierreDiffEditState(
      {},
      'orphaned',
      parseDiffFromFile({ name: 'file', contents: 'old\n' }, { name: 'file', contents: 'new\n' })
    )
  )
  editor.edit(new FileDiff<PierreDiffAnnotationData>())
  editor.cleanUp('discard')
  const reopened = create('orphaned')
  expect(reopened.key).toBe('orphaned')
  reopened.finish()
})

it('keeps the scope reserved across a recycle so a remount cannot share the key', () => {
  const editor = createPierreEditor(
    'file-diff',
    withPierreDiffEditState(
      {},
      'recycled',
      parseDiffFromFile({ name: 'file', contents: 'old\n' }, { name: 'file', contents: 'new\n' })
    )
  )
  editor.edit(new FileDiff<PierreDiffAnnotationData>())
  editor.cleanUp('recycle')
  const concurrent = create('recycled')
  expect(concurrent.key).not.toBe('recycled')
  concurrent.finish()
  editor.cleanUp('discard')
})

it('evicts dormant document history when retained text exceeds the budget', () => {
  const editor = create('oversized-history')
  const state = stored()
  state.document.history.undoStack = [
    { forwardEdits: [], inverseEdits: [{ text: 'x'.repeat(16_000_001) }] }
  ]
  states.set(editor.key, state)
  editor.finish()
  expect(clear).toHaveBeenCalledWith('file-diff', editor.key)
  expect(states.has(editor.key)).toBe(false)
})

it('rebuilds the session when the old side was renamed', () => {
  const state = stored()
  states.set('renamed', state)
  const diff = parseDiffFromFile(
    { name: 'other', contents: 'old\n' },
    { name: 'file', contents: 'new\n' }
  )
  const editor = createPierreEditor('file-diff', withPierreDiffEditState({}, 'renamed', diff))
  const initialState =
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked Editor above exposes these construction options and key for assertions.
    (editor as unknown as { options: { initialState?: { diffSession?: unknown } } }).options
      .initialState
  // Pierre throws on a retained session that cannot resume against the delivered old file,
  // so a rename must fall back to a rebuilt session rather than preserving this one.
  expect(initialState?.diffSession).toBeUndefined()
  editor.edit(new FileDiff<PierreDiffAnnotationData>())()
})
