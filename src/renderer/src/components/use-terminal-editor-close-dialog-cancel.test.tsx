// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestEditorFileClose } from './editor/editor-autosave'
import {
  useTerminalEditorCloseDialogActions,
  type TerminalEditorCloseDialogActionsInput
} from './use-terminal-editor-close-dialog-actions'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ openFiles: [] }) } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: vi.fn() }))

function controller(): TerminalEditorCloseDialogActionsInput {
  return {
    advanceEditorCloseQueue: vi.fn(),
    closeReactionsRef: { current: new Map() },
    inFlightSaveFileIdRef: { current: null },
    isClosingRef: { current: false },
    pendingEditorCloseQueueRef: { current: [] },
    queueEditorCloseRequests: vi.fn(),
    releaseCloseDialogGuardAfterDebounce: vi.fn(),
    saveDialogFileId: 'nb.ipynb',
    setSaveDialogFileId: vi.fn(),
    settleQueuedClose: vi.fn(),
    waitForFileClosed: vi.fn(async () => true),
    windowCloseAfterDirtyRef: { current: null }
  }
}

describe('cancelling the unsaved-changes prompt', () => {
  afterEach(cleanup)

  it('tells every pending close request it was cancelled, and keeps earlier requests', () => {
    const input = controller()
    const { result } = renderHook(() => useTerminalEditorCloseDialogActions(input))
    const first = { onClosed: vi.fn(), onCancelled: vi.fn() }
    const second = { onClosed: vi.fn(), onCancelled: vi.fn() }
    const claim = vi.fn()
    act(() => {
      requestEditorFileClose('nb.ipynb', first)
      requestEditorFileClose('nb.ipynb', { ...second, claim })
    })
    expect(claim).toHaveBeenCalledOnce()
    act(() => result.current.handleSaveDialogCancel())
    expect(first.onCancelled).toHaveBeenCalledOnce()
    expect(second.onCancelled).toHaveBeenCalledOnce()
    expect(first.onClosed).not.toHaveBeenCalled()
    expect(input.closeReactionsRef.current.size).toBe(0)
  })
})
