import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchWindowCloseRequest,
  getWindowCloseRequestHandler,
  setWindowCloseRequestHandler
} from './window-close-request-coordinator'

describe('window-close-request-coordinator', () => {
  const confirmWindowClose = vi.fn()

  beforeEach(() => {
    confirmWindowClose.mockClear()
    // Why: dispatch falls back to the preload bridge when no rich handler is
    // registered; stub just the surface it touches.
    ;(
      globalThis as unknown as { window: { api: { ui: { confirmWindowClose: () => void } } } }
    ).window = { api: { ui: { confirmWindowClose } } }
  })

  afterEach(() => {
    setWindowCloseRequestHandler(null)
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
  it('confirms the close directly when no rich handler is registered (no-workspace path)', () => {
    dispatchWindowCloseRequest({ isQuitting: true })

    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('delegates to the rich handler and does NOT confirm directly when one is registered', () => {
    const handler = vi.fn()
    setWindowCloseRequestHandler(handler)

    dispatchWindowCloseRequest({ isQuitting: false })

    expect(handler).toHaveBeenCalledWith({ isQuitting: false })
    // Why: confirmation is the rich handler's responsibility (after save dialogs
    // / running-process checks) — dispatch must not short-circuit it.
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })
})
