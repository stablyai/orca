import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from '../../editor-slice-test-harness'

describe('editor cursor-line store notifications', () => {
  it('does not notify subscribers or copy accumulated lines for same-line cursor movement', () => {
    const store = createEditorStore()
    store.setState({
      editorCursorLine: Object.fromEntries(
        Array.from({ length: 250 }, (_, index) => [`file-${index}`, index + 1])
      )
    })
    const before = store.getState()
    let subscriberCalls = 0
    const unsubscribe = store.subscribe(() => {
      subscriberCalls += 1
    })

    for (let column = 1; column <= 2_000; column += 1) {
      store.getState().setEditorCursorLine('file-49', 50)
    }

    unsubscribe()
    expect(subscriberCalls).toBe(0)
    expect(store.getState()).toBe(before)
    expect(store.getState().editorCursorLine).toBe(before.editorCursorLine)
  })

  it('publishes exactly once for a changed line and preserves other file positions', () => {
    const store = createEditorStore()
    store.getState().setEditorCursorLine('local-file', 10)
    store.getState().setEditorCursorLine('remote-file', 30)
    const before = store.getState().editorCursorLine
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    store.getState().setEditorCursorLine('local-file', 11)
    store.getState().setEditorCursorLine('local-file', 11)

    unsubscribe()
    expect(subscriber).toHaveBeenCalledOnce()
    expect(before).toEqual({ 'local-file': 10, 'remote-file': 30 })
    expect(store.getState().editorCursorLine).toEqual({ 'local-file': 11, 'remote-file': 30 })
  })

  it('records the initial position independently for each file identity', () => {
    const store = createEditorStore()
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    store.getState().setEditorCursorLine('editor:workspace:local:file.ts', 1)
    store.getState().setEditorCursorLine('editor:workspace:runtime-a:file.ts', 1)
    store.getState().setEditorCursorLine('editor:workspace:runtime-a:file.ts', 1)

    unsubscribe()
    expect(subscriber).toHaveBeenCalledTimes(2)
    expect(store.getState().editorCursorLine).toEqual({
      'editor:workspace:local:file.ts': 1,
      'editor:workspace:runtime-a:file.ts': 1
    })
  })
})
