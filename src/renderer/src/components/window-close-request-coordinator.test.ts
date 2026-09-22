// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  consumeShutdownCheckpointFailureReason,
  publishShutdownCheckpointFailureReason
} from '../../../shared/renderer-shutdown-events'
import {
  createShutdownCheckpointBeforeUnloadHandler,
  createShutdownCheckpointGuard
} from '../lib/shutdown-checkpoint-guard'
import {
  dispatchWindowCloseRequest,
  getWindowCloseRequestHandler,
  isWindowCloseCheckpointInProgress,
  registerWindowCloseGuard,
  runWithWindowCloseCheckpointScope,
  setWindowCloseRequestHandler
} from './window-close-request-coordinator'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('window-close-request-coordinator', () => {
  const confirmWindowClose = vi.fn()
  const unregisterFns: (() => void)[] = []

  const addGuard = (guard: () => boolean | Promise<boolean>): void => {
    unregisterFns.push(registerWindowCloseGuard(guard))
  }

  beforeEach(() => {
    confirmWindowClose.mockClear()
    vi.mocked(toast.error).mockClear()
    // Why: dispatch falls back to the preload bridge when no rich handler is
    // registered; stub just the surface it touches.
    const windowTarget = new EventTarget() as EventTarget & {
      api: { ui: { confirmWindowClose: () => void } }
    }
    windowTarget.api = { ui: { confirmWindowClose } }
    ;(globalThis as unknown as { window: typeof windowTarget }).window = windowTarget
  })

  afterEach(() => {
    setWindowCloseRequestHandler(null)
    unregisterFns.splice(0).forEach((fn) => fn())
    consumeShutdownCheckpointFailureReason()
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

  it('runs the Terminal-less close checkpoint in the degradable close scope', async () => {
    const beforeUnload = vi.fn((event: Event) => {
      expect(isWindowCloseCheckpointInProgress()).toBe(true)
      event.preventDefault()
    })
    window.addEventListener('beforeunload', beforeUnload, { once: true })

    await dispatchWindowCloseRequest({ isQuitting: true })

    expect(beforeUnload).toHaveBeenCalledTimes(1)
    expect(confirmWindowClose).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(isWindowCloseCheckpointInProgress()).toBe(false)
  })

  it('surfaces the checkpoint failure reason when the Terminal-less close is vetoed', async () => {
    window.addEventListener(
      'beforeunload',
      (event) => {
        publishShutdownCheckpointFailureReason('sendSync payload rejected')
        event.preventDefault()
      },
      { once: true }
    )

    await dispatchWindowCloseRequest({ isQuitting: true })

    expect(confirmWindowClose).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'Quit canceled: the session snapshot could not be saved (sendSync payload rejected).'
    )
    expect(consumeShutdownCheckpointFailureReason()).toBeNull()
  })

  it('shows a fallback reason when a Terminal-less checkpoint throws an empty Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('placeholder')
    error.message = ''
    const guard = createShutdownCheckpointGuard(() => {
      throw error
    })
    window.addEventListener('beforeunload', createShutdownCheckpointBeforeUnloadHandler(guard), {
      once: true
    })

    await dispatchWindowCloseRequest({ isQuitting: true })

    expect(confirmWindowClose).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'Quit canceled: the session snapshot could not be saved (Unknown shutdown checkpoint failure).'
    )
  })

  it('delegates to the rich handler and does NOT confirm directly when one is registered', async () => {
    const handler = vi.fn()
    setWindowCloseRequestHandler(handler)

    await dispatchWindowCloseRequest({ isQuitting: false })

    expect(handler).toHaveBeenCalledWith({ isQuitting: false })
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
    expect(toast.error).not.toHaveBeenCalled()
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

  it('scopes the window-close checkpoint flag to the wrapped dispatch (STA-5505)', () => {
    expect(isWindowCloseCheckpointInProgress()).toBe(false)
    const seen = runWithWindowCloseCheckpointScope(() => isWindowCloseCheckpointInProgress())
    expect(seen).toBe(true)
    expect(isWindowCloseCheckpointInProgress()).toBe(false)
  })

  it('clears the window-close checkpoint flag when the wrapped dispatch throws', () => {
    expect(() =>
      runWithWindowCloseCheckpointScope(() => {
        throw new Error('listener exploded')
      })
    ).toThrow('listener exploded')
    expect(isWindowCloseCheckpointInProgress()).toBe(false)
  })
})
