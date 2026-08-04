// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  BrowserJavaScriptDialogClosedEvent,
  BrowserJavaScriptDialogOpenedEvent
} from '../../../../shared/browser-javascript-dialog'
import { useBrowserJavaScriptDialog } from './use-browser-javascript-dialog'

function pendingDialog(): BrowserJavaScriptDialogOpenedEvent {
  return {
    browserPageId: 'page-1',
    dialogId: 'dialog-1',
    dialogType: 'confirm',
    message: 'Continue?',
    defaultPromptText: '',
    origin: 'https://example.com'
  }
}

function installBrowserApi(getJavaScriptDialog = vi.fn().mockResolvedValue(null)) {
  let opened: ((event: BrowserJavaScriptDialogOpenedEvent) => void) | null = null
  let closed: ((event: BrowserJavaScriptDialogClosedEvent) => void) | null = null
  const respondJavaScriptDialog = vi.fn().mockResolvedValue(true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        getJavaScriptDialog,
        respondJavaScriptDialog,
        onJavaScriptDialogOpened: vi.fn((callback) => {
          opened = callback
          return () => {
            opened = null
          }
        }),
        onJavaScriptDialogClosed: vi.fn((callback) => {
          closed = callback
          return () => {
            closed = null
          }
        })
      }
    }
  })
  return {
    getJavaScriptDialog,
    respondJavaScriptDialog,
    emitOpened: (event: BrowserJavaScriptDialogOpenedEvent) => opened?.(event),
    emitClosed: (event: BrowserJavaScriptDialogClosedEvent) => closed?.(event)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBrowserJavaScriptDialog', () => {
  it('hydrates a dialog that opened while its worktree pane was unmounted', async () => {
    const api = installBrowserApi(vi.fn().mockResolvedValue(pendingDialog()))
    const { result } = renderHook(() => useBrowserJavaScriptDialog('page-1'))

    await waitFor(() => expect(result.current.dialog).toEqual(pendingDialog()))
    expect(api.getJavaScriptDialog).toHaveBeenCalledWith({ browserPageId: 'page-1' })

    await act(() => result.current.respond(false))
    expect(api.respondJavaScriptDialog).toHaveBeenCalledWith({
      browserPageId: 'page-1',
      dialogId: 'dialog-1',
      accept: false,
      promptText: undefined
    })
  })

  it('ignores dialog events owned by another browser page', async () => {
    const api = installBrowserApi()
    const { result } = renderHook(() => useBrowserJavaScriptDialog('page-1'))

    await waitFor(() => expect(api.getJavaScriptDialog).toHaveBeenCalled())
    act(() => api.emitOpened({ ...pendingDialog(), browserPageId: 'page-2' }))
    expect(result.current.dialog).toBeNull()

    act(() => api.emitOpened(pendingDialog()))
    act(() => api.emitClosed({ browserPageId: 'page-2', dialogId: pendingDialog().dialogId }))
    expect(result.current.dialog).toEqual(pendingDialog())
  })

  it('does not let a stale hydration response overwrite a newer dialog event', async () => {
    let resolveQuery: (dialog: BrowserJavaScriptDialogOpenedEvent | null) => void = () => {}
    const query = new Promise<BrowserJavaScriptDialogOpenedEvent | null>((resolve) => {
      resolveQuery = resolve
    })
    const api = installBrowserApi(vi.fn(() => query))
    const { result } = renderHook(() => useBrowserJavaScriptDialog('page-1'))

    act(() => api.emitOpened(pendingDialog()))
    await act(async () => resolveQuery(null))

    expect(result.current.dialog).toEqual(pendingDialog())
    act(() => api.emitClosed({ browserPageId: 'page-1', dialogId: 'dialog-1' }))
    expect(result.current.dialog).toBeNull()
  })
})
