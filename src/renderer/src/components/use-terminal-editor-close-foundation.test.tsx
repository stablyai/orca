// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const confirmWindowClose = vi.fn()
const cancelWindowClose = vi.fn()

vi.mock('../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ tabsByWorktree: {}, ptyIdsByTabId: {} })
  })
}))
vi.mock('../lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))
vi.mock('@/lib/shutdown-checkpoint-guard', () => ({
  preventUnloadAndScheduleShutdownCheckpointReset: vi.fn()
}))

import { useTerminalEditorCloseFoundation } from './use-terminal-editor-close-foundation'

afterEach(() => {
  confirmWindowClose.mockReset()
  cancelWindowClose.mockReset()
  window.onbeforeunload = null
})

describe('useTerminalEditorCloseFoundation', () => {
  it('cancels the correlated close when the dirty-file checkpoint vetoes', () => {
    Object.assign(window, {
      api: { ui: { confirmWindowClose, cancelWindowClose } }
    })
    window.addEventListener('beforeunload', (event) => event.preventDefault(), { once: true })
    const { result } = renderHook(() =>
      useTerminalEditorCloseFoundation({ openFiles: [] } as never)
    )

    act(() => result.current.confirmNativeWindowClose(42))

    expect(cancelWindowClose).toHaveBeenCalledWith(42)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })
})
