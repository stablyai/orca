// @vitest-environment happy-dom

/**
 * Wiring for the window-close/quit running-work warning. The policy in
 * `terminal/window-close-running-work.ts` is inert unless `proceedToNativeWindowClose` actually
 * consults it, so pin that it does — and that a warning stops the native close rather than
 * confirming it.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { assessWindowCloseRunningWorkMock, cancelWindowCloseMock, confirmWindowCloseMock } =
  vi.hoisted(() => ({
    assessWindowCloseRunningWorkMock: vi.fn(),
    cancelWindowCloseMock: vi.fn(),
    confirmWindowCloseMock: vi.fn()
  }))

vi.mock('./terminal/window-close-running-work', () => ({
  assessWindowCloseRunningWork: assessWindowCloseRunningWorkMock
}))
vi.mock('./window-close-request-coordinator', () => ({
  runWithWindowCloseCheckpointScope: (fn: () => unknown) => fn()
}))
vi.mock('@/lib/shutdown-checkpoint-failure-toast', () => ({
  showShutdownCheckpointFailureToast: vi.fn()
}))

const { useTerminalEditorCloseFoundation } = await import('./use-terminal-editor-close-foundation')

const controller = { openFiles: [] } as unknown as Parameters<
  typeof useTerminalEditorCloseFoundation
>[0]

function mountFoundation() {
  return renderHook(() => useTerminalEditorCloseFoundation(controller))
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, {
    window: Object.assign(globalThis.window, {
      api: {
        ui: {
          cancelWindowClose: cancelWindowCloseMock,
          confirmWindowClose: confirmWindowCloseMock
        }
      }
    })
  })
})

afterEach(() => {
  cleanup()
})

describe('proceedToNativeWindowClose', () => {
  it('asks the running-work policy about the quit rather than assuming it is safe', async () => {
    assessWindowCloseRunningWorkMock.mockResolvedValue({ kind: 'none' })
    const { result } = mountFoundation()

    await act(async () => {
      result.current.proceedToNativeWindowClose(true, 42)
    })

    expect(assessWindowCloseRunningWorkMock).toHaveBeenCalledWith({ isQuitting: true })
    expect(confirmWindowCloseMock).toHaveBeenCalledTimes(1)
    expect(result.current.windowCloseDialogOpen).toBe(false)
  })

  it('raises the dialog and does not close when a host reports live work', async () => {
    assessWindowCloseRunningWorkMock.mockResolvedValue({ kind: 'running' })
    const { result } = mountFoundation()

    await act(async () => {
      result.current.proceedToNativeWindowClose(true, 42)
    })

    expect(result.current.windowCloseDialogOpen).toBe(true)
    expect(result.current.windowCloseDialogKind).toBe('running')
    expect(confirmWindowCloseMock).not.toHaveBeenCalled()

    act(() => result.current.cancelWindowCloseDialog())

    expect(cancelWindowCloseMock).toHaveBeenCalledWith(42)
    expect(result.current.windowCloseDialogOpen).toBe(false)
  })

  it('raises the unverifiable copy when a remote host could not be reached', async () => {
    assessWindowCloseRunningWorkMock.mockResolvedValue({ kind: 'unverifiable' })
    const { result } = mountFoundation()

    await act(async () => {
      result.current.proceedToNativeWindowClose(true, 43)
    })

    expect(result.current.windowCloseDialogOpen).toBe(true)
    expect(result.current.windowCloseDialogKind).toBe('unverifiable')
    expect(confirmWindowCloseMock).not.toHaveBeenCalled()
  })

  it('cancels a running-work close only once when the dialog dismisses twice', async () => {
    assessWindowCloseRunningWorkMock.mockResolvedValue({ kind: 'running' })
    const { result } = mountFoundation()

    await act(async () => {
      result.current.proceedToNativeWindowClose(true, 44)
    })
    act(() => {
      result.current.cancelWindowCloseDialog()
      result.current.cancelWindowCloseDialog()
    })

    expect(cancelWindowCloseMock).toHaveBeenCalledTimes(1)
    expect(cancelWindowCloseMock).toHaveBeenCalledWith(44)
  })

  it('does not reopen a cancelled dialog when an older assessment settles later', async () => {
    let resolveOlder!: (value: { kind: 'running' }) => void
    const olderAssessment = new Promise<{ kind: 'running' }>((resolve) => {
      resolveOlder = resolve
    })
    assessWindowCloseRunningWorkMock
      .mockReturnValueOnce(olderAssessment)
      .mockResolvedValueOnce({ kind: 'running' })
    const { result } = mountFoundation()

    act(() => result.current.proceedToNativeWindowClose(true, 45))
    await act(async () => {
      result.current.proceedToNativeWindowClose(true, 46)
    })
    act(() => result.current.cancelWindowCloseDialog())
    await act(async () => resolveOlder({ kind: 'running' }))

    expect(cancelWindowCloseMock).toHaveBeenCalledTimes(1)
    expect(cancelWindowCloseMock).toHaveBeenCalledWith(46)
    expect(result.current.windowCloseDialogOpen).toBe(false)
  })

  it('does not confirm from an older failed assessment while a newer dialog is pending', async () => {
    let rejectOlder!: (reason: Error) => void
    const olderAssessment = new Promise<never>((_resolve, reject) => {
      rejectOlder = reject
    })
    assessWindowCloseRunningWorkMock
      .mockReturnValueOnce(olderAssessment)
      .mockResolvedValueOnce({ kind: 'running' })
    const { result } = mountFoundation()

    act(() => result.current.proceedToNativeWindowClose(true, 47))
    await act(async () => {
      result.current.proceedToNativeWindowClose(true, 48)
    })
    await act(async () => rejectOlder(new Error('older probe failed')))

    expect(result.current.windowCloseDialogOpen).toBe(true)
    expect(confirmWindowCloseMock).not.toHaveBeenCalled()
    act(() => result.current.cancelWindowCloseDialog())
    expect(cancelWindowCloseMock).toHaveBeenCalledWith(48)
  })

  it('confirms only once when close and dismiss callbacks both fire', async () => {
    assessWindowCloseRunningWorkMock.mockResolvedValue({ kind: 'running' })
    const { result } = mountFoundation()

    await act(async () => {
      result.current.proceedToNativeWindowClose(true, 52)
    })
    act(() => {
      result.current.confirmWindowCloseDialog()
      result.current.cancelWindowCloseDialog()
      result.current.confirmWindowCloseDialog()
    })

    expect(confirmWindowCloseMock).toHaveBeenCalledTimes(1)
    expect(cancelWindowCloseMock).not.toHaveBeenCalled()
    expect(result.current.windowCloseDialogOpen).toBe(false)
  })

  it('keeps the request id when a confirmed running-work close is vetoed', async () => {
    assessWindowCloseRunningWorkMock.mockResolvedValue({ kind: 'running' })
    const preventClose = (event: Event): void => event.preventDefault()
    window.addEventListener('beforeunload', preventClose, { once: true })
    const { result } = mountFoundation()

    await act(async () => {
      result.current.proceedToNativeWindowClose(true, 49)
    })
    act(() => result.current.confirmWindowCloseDialog())

    expect(cancelWindowCloseMock).toHaveBeenCalledWith(49)
    expect(confirmWindowCloseMock).not.toHaveBeenCalled()
    expect(result.current.windowCloseDialogOpen).toBe(false)
  })

  // Why: a thrown assessment is not evidence either way, and a close that silently does nothing
  // leaves SIGKILL as the user's only exit.
  it('falls through to the close when the assessment throws', async () => {
    assessWindowCloseRunningWorkMock.mockRejectedValue(new Error('store blew up'))
    const { result } = mountFoundation()

    await act(async () => {
      result.current.proceedToNativeWindowClose(false, 50)
    })

    expect(confirmWindowCloseMock).toHaveBeenCalledTimes(1)
    expect(result.current.windowCloseDialogOpen).toBe(false)
  })

  it('keeps the request id when the assessment throws and the close is vetoed', async () => {
    assessWindowCloseRunningWorkMock.mockRejectedValue(new Error('store blew up'))
    const preventClose = (event: Event): void => event.preventDefault()
    window.addEventListener('beforeunload', preventClose, { once: true })
    const { result } = mountFoundation()

    await act(async () => {
      result.current.proceedToNativeWindowClose(false, 51)
    })

    expect(cancelWindowCloseMock).toHaveBeenCalledWith(51)
    expect(confirmWindowCloseMock).not.toHaveBeenCalled()
  })
})
