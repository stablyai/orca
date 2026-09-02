// @vitest-environment happy-dom
import type { Editor } from '@tiptap/react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingEditorFocusRequest } from '@/store/slices/editor'

type StoreFixture = {
  pendingEditorFocusRequest: PendingEditorFocusRequest | null
  consumeEditorFocusRequest: ReturnType<typeof vi.fn>
}

const fixture = vi.hoisted(() => ({
  store: {
    pendingEditorFocusRequest: null,
    consumeEditorFocusRequest: vi.fn()
  } as StoreFixture,
  autoFocusRichEditor: vi.fn(() => vi.fn())
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreFixture) => unknown) => selector(fixture.store)
}))

vi.mock('./rich-markdown-auto-focus', () => ({
  autoFocusRichEditor: fixture.autoFocusRichEditor
}))

import { useRichMarkdownPendingFocus } from './useRichMarkdownPendingFocus'

type EditorFixture = {
  editor: Editor
  focus: () => void
}

function createEditorFixture(destroyed = false): EditorFixture {
  const focusListeners = new Set<() => void>()
  let focused = false
  return {
    editor: {
      isDestroyed: destroyed,
      get isFocused() {
        return focused
      },
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'focus') {
          focusListeners.add(listener)
        }
      }),
      off: vi.fn((event: string, listener: () => void) => {
        if (event === 'focus') {
          focusListeners.delete(listener)
        }
      })
    } as unknown as Editor,
    focus: () => {
      focused = true
      for (const listener of focusListeners) {
        listener()
      }
    }
  }
}

function pendingRequest(overrides: Partial<PendingEditorFocusRequest> = {}) {
  return {
    fileId: 'file-1',
    worktreeId: 'worktree-1',
    viewStateId: 'view-1',
    expiresAt: Date.now() + 30_000,
    token: 7,
    ...overrides
  }
}

function renderPendingFocus(editor: Editor | null, viewStateId = 'view-1') {
  return renderHook(
    ({ nextEditor }) =>
      useRichMarkdownPendingFocus({
        editor: nextEditor,
        fileId: 'file-1',
        viewStateId,
        worktreeId: 'worktree-1',
        rootRef: { current: null },
        cancelAutoFocusRef: { current: null }
      }),
    { initialProps: { nextEditor: editor } }
  )
}

describe('useRichMarkdownPendingFocus', () => {
  afterEach(() => {
    vi.useRealTimers()
    fixture.store.pendingEditorFocusRequest = null
    fixture.store.consumeEditorFocusRequest.mockReset()
    fixture.autoFocusRichEditor.mockReset()
    fixture.autoFocusRichEditor.mockReturnValue(vi.fn())
  })

  it('consumes the request only after delayed editor focus lands', () => {
    const editor = createEditorFixture()
    fixture.store.pendingEditorFocusRequest = pendingRequest()

    const hook = renderPendingFocus(editor.editor)

    expect(fixture.store.consumeEditorFocusRequest).not.toHaveBeenCalled()
    act(editor.focus)
    expect(fixture.store.consumeEditorFocusRequest).toHaveBeenCalledWith(7)

    hook.unmount()
    expect(editor.editor.off).toHaveBeenCalledWith('focus', expect.any(Function))
  })

  it('retries a request when Tiptap replaces a destroyed editor', () => {
    const destroyed = createEditorFixture(true)
    const replacement = createEditorFixture()
    fixture.store.pendingEditorFocusRequest = pendingRequest()
    fixture.autoFocusRichEditor.mockImplementationOnce(() => {
      replacement.focus()
      return vi.fn()
    })

    const hook = renderPendingFocus(destroyed.editor)
    expect(fixture.autoFocusRichEditor).not.toHaveBeenCalled()

    hook.rerender({ nextEditor: replacement.editor })

    expect(fixture.store.consumeEditorFocusRequest).toHaveBeenCalledWith(7)
  })

  it('does not let another split pane claim the request', () => {
    fixture.store.pendingEditorFocusRequest = pendingRequest()

    renderPendingFocus(createEditorFixture().editor, 'view-2')

    expect(fixture.autoFocusRichEditor).not.toHaveBeenCalled()
    expect(fixture.store.consumeEditorFocusRequest).not.toHaveBeenCalled()
  })

  it('retires an expired request without stealing focus', () => {
    fixture.store.pendingEditorFocusRequest = pendingRequest({ expiresAt: Date.now() - 1 })

    renderPendingFocus(null)

    expect(fixture.autoFocusRichEditor).not.toHaveBeenCalled()
    expect(fixture.store.consumeEditorFocusRequest).toHaveBeenCalledWith(7)
  })

  it('cancels a pending forced focus when its request expires', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'))
    const cancelFocus = vi.fn()
    fixture.store.pendingEditorFocusRequest = pendingRequest({ expiresAt: Date.now() + 1_000 })
    fixture.autoFocusRichEditor.mockReturnValue(cancelFocus)

    renderPendingFocus(createEditorFixture().editor)
    act(() => {
      vi.advanceTimersByTime(1_000)
    })

    expect(cancelFocus).toHaveBeenCalledOnce()
    expect(fixture.store.consumeEditorFocusRequest).toHaveBeenCalledWith(7)
  })
})
