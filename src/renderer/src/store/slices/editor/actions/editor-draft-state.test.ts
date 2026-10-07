import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from '../../editor-slice-test-harness'

describe('editor draft publications', () => {
  it.each(['', 'unsaved edit'])('does not publish an identical existing draft: %j', (content) => {
    const store = createEditorStore()
    store.getState().setEditorDraft('/repo/file.ts', content)
    const before = store.getState()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().setEditorDraft('/repo/file.ts', content)

    expect(store.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('publishes a new empty draft and a changed draft exactly once each', () => {
    const store = createEditorStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().setEditorDraft('/repo/file.ts', '')
    expect(store.getState().editorDrafts).toEqual({ '/repo/file.ts': '' })
    expect(listener).toHaveBeenCalledTimes(1)

    listener.mockClear()
    store.getState().setEditorDraft('/repo/file.ts', 'changed')
    expect(store.getState().editorDrafts).toEqual({ '/repo/file.ts': 'changed' })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('scopes draft equality to the exact editor identity', () => {
    const store = createEditorStore()
    store.getState().setEditorDraft('local-file', 'same text')
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().setEditorDraft('remote-file', 'same text')

    expect(store.getState().editorDrafts).toEqual({
      'local-file': 'same text',
      'remote-file': 'same text'
    })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})
