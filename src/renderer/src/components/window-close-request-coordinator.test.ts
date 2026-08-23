import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { retireWindowTerminalTabsAndConfirmClose } = vi.hoisted(() => ({
  retireWindowTerminalTabsAndConfirmClose: vi.fn(() => Promise.resolve('confirmed'))
}))

vi.mock('./terminal/terminal-window-close-retirement', () => ({
  retireWindowTerminalTabsAndConfirmClose
}))

import {
  dispatchWindowCloseRequest,
  getWindowCloseRequestHandler,
  registerWindowCloseGuard,
  setWindowCloseRequestHandler,
  useWindowCloseRunningProcessConfirmStore
} from './window-close-request-coordinator'

describe('window-close-request-coordinator', () => {
  const confirmWindowClose = vi.fn()
  const unregisterFns: (() => void)[] = []

  const addGuard = (guard: () => boolean | Promise<boolean>): void => {
    unregisterFns.push(registerWindowCloseGuard(guard))
  }

  beforeEach(() => {
    confirmWindowClose.mockClear()
    retireWindowTerminalTabsAndConfirmClose.mockClear()
    const cancelWindowClose = vi.fn()
    const hasChildProcesses = vi.fn(() => Promise.resolve(false))
    // Why: dispatch falls back to the preload bridge when no rich handler is
    // registered; stub just the surface it touches.
    ;(
      globalThis as unknown as {
        window: {
          api: {
            ui: { cancelWindowClose: () => void; confirmWindowClose: () => boolean }
            pty: { hasChildProcesses: (ptyId: string) => Promise<boolean> }
          }
        }
      }
    ).window = {
      api: { ui: { cancelWindowClose, confirmWindowClose }, pty: { hasChildProcesses } }
    }
  })

  afterEach(() => {
    setWindowCloseRequestHandler(null)
    unregisterFns.splice(0).forEach((fn) => fn())
  })

  it('prompts once for a staged durable-only running PTY and cancels the main transaction', async () => {
    vi.mocked(window.api.pty.hasChildProcesses).mockResolvedValue(true)

    const close = dispatchWindowCloseRequest({
      isQuitting: false,
      ownedProviderPtyIds: ['durable-pty']
    })
    await vi.waitFor(() =>
      expect(
        useWindowCloseRunningProcessConfirmStore.getState().windowCloseRunningProcessConfirm
      ).not.toBeNull()
    )
    await dispatchWindowCloseRequest({
      isQuitting: false,
      ownedProviderPtyIds: ['durable-pty']
    })

    expect(window.api.pty.hasChildProcesses).toHaveBeenCalledTimes(1)
    useWindowCloseRunningProcessConfirmStore.getState().cancelWindowCloseRunningProcessConfirm()
    await close

    expect(window.api.ui.cancelWindowClose).toHaveBeenCalledTimes(1)
    expect(retireWindowTerminalTabsAndConfirmClose).not.toHaveBeenCalled()
  })

  it('retires after one durable-only running-process confirmation', async () => {
    vi.mocked(window.api.pty.hasChildProcesses).mockResolvedValue(true)

    const close = dispatchWindowCloseRequest({
      isQuitting: false,
      ownedProviderPtyIds: ['durable-pty']
    })
    await vi.waitFor(() =>
      expect(
        useWindowCloseRunningProcessConfirmStore.getState().windowCloseRunningProcessConfirm
      ).not.toBeNull()
    )
    useWindowCloseRunningProcessConfirmStore.getState().confirmWindowCloseRunningProcessConfirm()
    await close

    expect(retireWindowTerminalTabsAndConfirmClose).toHaveBeenCalledOnce()
    expect(retireWindowTerminalTabsAndConfirmClose).toHaveBeenCalledWith(undefined, ['durable-pty'])
  })

  it('escalates a pending user prompt to App quit without killing or waiting for the dialog', async () => {
    vi.mocked(window.api.pty.hasChildProcesses).mockResolvedValue(true)
    const handler = vi.fn()
    setWindowCloseRequestHandler(handler)
    const userClose = dispatchWindowCloseRequest({
      isQuitting: false,
      ownedProviderPtyIds: ['durable-pty']
    })
    await vi.waitFor(() =>
      expect(
        useWindowCloseRunningProcessConfirmStore.getState().windowCloseRunningProcessConfirm
      ).not.toBeNull()
    )

    await dispatchWindowCloseRequest({ isQuitting: true })
    await userClose

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ isQuitting: true })
    expect(window.api.ui.cancelWindowClose).not.toHaveBeenCalled()
    expect(
      useWindowCloseRunningProcessConfirmStore.getState().windowCloseRunningProcessConfirm
    ).toBeNull()
  })

  it('has no handler by default, so the App root falls back to confirming the close', () => {
    // Why: on the no-workspace landing page Terminal is not mounted, so no rich
    // handler is registered and the App-root subscription must close directly.
    expect(getWindowCloseRequestHandler()).toBeNull()
  })

  it('returns the registered handler so the App root delegates to Terminal', () => {
    const handler = vi.fn()
    setWindowCloseRequestHandler(handler)
    expect(getWindowCloseRequestHandler()).toBe(handler)
  })

  it('clears the handler on unmount so a stale Terminal closure cannot run', () => {
    setWindowCloseRequestHandler(vi.fn())
    setWindowCloseRequestHandler(null)
    expect(getWindowCloseRequestHandler()).toBeNull()
  })

  // The #5144 contract: a close request must always be acted on.
  it('confirms the close directly when no rich handler is registered (no-workspace path)', async () => {
    await dispatchWindowCloseRequest({ isQuitting: true })

    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('retires durable window terminals before a user close without a rich handler', async () => {
    await dispatchWindowCloseRequest({
      isQuitting: false,
      ownedProviderPtyIds: ['secondary-pty']
    })

    expect(retireWindowTerminalTabsAndConfirmClose).toHaveBeenCalledWith(undefined, [
      'secondary-pty'
    ])
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('delegates to the rich handler and does NOT confirm directly when one is registered', async () => {
    const handler = vi.fn()
    setWindowCloseRequestHandler(handler)

    await dispatchWindowCloseRequest({
      isQuitting: false,
      ownedProviderPtyIds: ['secondary-pty']
    })

    expect(handler).toHaveBeenCalledWith({
      isQuitting: false,
      ownedProviderPtyIds: ['secondary-pty']
    })
    // Why: confirmation is the rich handler's responsibility (after save dialogs
    // / running-process checks) — dispatch must not short-circuit it.
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  // Pre-close guards (e.g. unsaved Settings prompt drafts).
  it('cancels the close — no confirm, no handler — when a guard vetoes', async () => {
    const handler = vi.fn()
    setWindowCloseRequestHandler(handler)
    addGuard(() => false)

    await dispatchWindowCloseRequest({ isQuitting: true })

    expect(confirmWindowClose).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('proceeds to confirm when all guards allow the close', async () => {
    addGuard(() => true)
    addGuard(async () => true)

    await dispatchWindowCloseRequest({ isQuitting: true })

    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('short-circuits on the first vetoing guard', async () => {
    const second = vi.fn(() => true)
    addGuard(() => false)
    addGuard(second)

    await dispatchWindowCloseRequest({ isQuitting: true })

    expect(second).not.toHaveBeenCalled()
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('ignores a re-entrant close request while a guard is still pending', async () => {
    let resolveGuard: (value: boolean) => void = () => {}
    const guard = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveGuard = resolve
        })
    )
    addGuard(guard)

    const first = dispatchWindowCloseRequest({ isQuitting: true })
    // Second request arrives while the first guard's dialog is still open.
    await dispatchWindowCloseRequest({ isQuitting: true })
    expect(guard).toHaveBeenCalledTimes(1)

    resolveGuard(true)
    await first
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('stops consulting a guard once it is unregistered', async () => {
    const guard = vi.fn(() => false)
    const unregister = registerWindowCloseGuard(guard)
    unregister()

    await dispatchWindowCloseRequest({ isQuitting: true })

    expect(guard).not.toHaveBeenCalled()
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })
})
