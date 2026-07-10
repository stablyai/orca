import type { editor } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGitConflictDecorationRefresher,
  GIT_CONFLICT_DECORATION_REFRESH_DELAY_MS
} from './monaco-conflict-decoration-refresh'
import { buildGitConflictDecorations, hasGitConflictMarkers } from './monaco-conflict-decorations'

// Why: spy-wrap the real scanners so tests can count full-content scans while
// keeping genuine marker parsing (the perf contract is "how often", not "what").
vi.mock('./monaco-conflict-decorations', { spy: true })

const CONFLICT_LINES = ['<<<<<<< HEAD', 'current', '=======', 'incoming', '>>>>>>> branch']

function conflictContentWithPrefix(prefixLineCount: number): string {
  return [
    ...Array.from({ length: prefixLineCount }, (_, i) => `line ${i}`),
    ...CONFLICT_LINES
  ].join('\n')
}

function scanCount(): number {
  return (
    vi.mocked(hasGitConflictMarkers).mock.calls.length +
    vi.mocked(buildGitConflictDecorations).mock.calls.length
  )
}

function createFakeEditor(): {
  editorInstance: editor.IStandaloneCodeEditor
  set: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
  createDecorationsCollection: ReturnType<typeof vi.fn>
} {
  const set = vi.fn()
  const clear = vi.fn()
  const createDecorationsCollection = vi.fn(() => ({ set, clear }))
  return {
    editorInstance: { createDecorationsCollection } as unknown as editor.IStandaloneCodeEditor,
    set,
    clear,
    createDecorationsCollection
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('createGitConflictDecorationRefresher', () => {
  it('scans immediately on the first refresh so decorations appear at mount', () => {
    const { editorInstance, createDecorationsCollection } = createFakeEditor()
    const refresher = createGitConflictDecorationRefresher(editorInstance)

    refresher.refresh(conflictContentWithPrefix(1))

    expect(createDecorationsCollection).toHaveBeenCalledTimes(1)
    expect(createDecorationsCollection.mock.calls[0]?.[0]).not.toHaveLength(0)
    expect(scanCount()).toBe(2)
  })

  it('coalesces a burst of content changes into exactly one scan and rebuild after settle', () => {
    const { editorInstance, set } = createFakeEditor()
    const refresher = createGitConflictDecorationRefresher(editorInstance)
    refresher.refresh(conflictContentWithPrefix(0))
    vi.clearAllMocks()

    for (let keystroke = 1; keystroke <= 5; keystroke += 1) {
      refresher.refresh(conflictContentWithPrefix(keystroke))
      vi.advanceTimersByTime(GIT_CONFLICT_DECORATION_REFRESH_DELAY_MS - 1)
    }
    expect(scanCount()).toBe(0)
    expect(set).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(vi.mocked(hasGitConflictMarkers)).toHaveBeenCalledExactlyOnceWith(
      conflictContentWithPrefix(5)
    )
    expect(vi.mocked(buildGitConflictDecorations)).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledTimes(1)
    // The rebuild reflects the final keystroke: 5 prefix lines put the conflict
    // start marker on line 6, so the leading "current" section starts on line 7.
    expect(set.mock.calls[0]?.[0]?.[0]?.range.startLineNumber).toBe(7)
  })

  it('reflects added and removed conflict markers after the debounce settles', () => {
    const { editorInstance, set, clear, createDecorationsCollection } = createFakeEditor()
    const refresher = createGitConflictDecorationRefresher(editorInstance)

    refresher.refresh('no markers yet')
    expect(createDecorationsCollection).not.toHaveBeenCalled()

    refresher.refresh(conflictContentWithPrefix(0))
    vi.advanceTimersByTime(GIT_CONFLICT_DECORATION_REFRESH_DELAY_MS)
    expect(createDecorationsCollection).toHaveBeenCalledTimes(1)
    expect(createDecorationsCollection.mock.calls[0]?.[0]).not.toHaveLength(0)

    refresher.refresh('resolved, markers deleted')
    expect(clear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(GIT_CONFLICT_DECORATION_REFRESH_DELAY_MS)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(set).not.toHaveBeenCalled()
  })

  it('never rescans identical content and drops a superseded pending scan on undo', () => {
    const { editorInstance, set } = createFakeEditor()
    const refresher = createGitConflictDecorationRefresher(editorInstance)
    const applied = conflictContentWithPrefix(0)
    refresher.refresh(applied)
    vi.clearAllMocks()

    refresher.refresh(applied)
    vi.runAllTimers()
    expect(scanCount()).toBe(0)

    refresher.refresh(conflictContentWithPrefix(1))
    refresher.refresh(applied)
    vi.runAllTimers()
    expect(scanCount()).toBe(0)
    expect(set).not.toHaveBeenCalled()
  })

  it('rebuilds immediately when asked (file/model switch), cancelling pending work', () => {
    const { editorInstance, set } = createFakeEditor()
    const refresher = createGitConflictDecorationRefresher(editorInstance)
    refresher.refresh(conflictContentWithPrefix(0))
    refresher.refresh(conflictContentWithPrefix(1))
    vi.clearAllMocks()

    refresher.refresh(conflictContentWithPrefix(3), { immediate: true })
    expect(set).toHaveBeenCalledTimes(1)
    // 3 prefix lines: marker on line 4, leading "current" section on line 5.
    expect(set.mock.calls[0]?.[0]?.[0]?.range.startLineNumber).toBe(5)

    vi.runAllTimers()
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('clear() drops decorations and pending scans without ever scanning', () => {
    const { editorInstance, set, clear } = createFakeEditor()
    const refresher = createGitConflictDecorationRefresher(editorInstance)
    refresher.refresh(conflictContentWithPrefix(0))
    refresher.refresh(conflictContentWithPrefix(1))
    vi.clearAllMocks()

    // Disabled-mode regression pin: typing maps to clear() calls, zero scans.
    refresher.clear()
    refresher.clear()
    vi.runAllTimers()
    expect(scanCount()).toBe(0)
    expect(set).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(2)

    // Re-enabling rescans immediately instead of debouncing behind stale state.
    refresher.refresh(conflictContentWithPrefix(2))
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('dispose mid-debounce leaks no timer and never touches decorations afterwards', () => {
    const { editorInstance, set, clear } = createFakeEditor()
    const refresher = createGitConflictDecorationRefresher(editorInstance)
    refresher.refresh(conflictContentWithPrefix(0))
    refresher.refresh(conflictContentWithPrefix(1))
    vi.clearAllMocks()

    refresher.dispose()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    vi.runAllTimers()
    expect(scanCount()).toBe(0)
    expect(set).not.toHaveBeenCalled()
  })
})
