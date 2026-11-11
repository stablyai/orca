// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  consumeShutdownCheckpointFailureReason,
  publishShutdownCheckpointFailureReason
} from '../../../shared/renderer-shutdown-events'

import {
  dispatchWindowCloseRequest,
  isWindowCloseCheckpointInProgress,
  registerWindowCloseGuard,
  setWindowCloseRequestHandler
} from './window-close-request-coordinator'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('window-close-request-coordinator', () => {
  const confirmWindowClose = vi.fn()
  const cancelWindowClose = vi.fn()
  const unregisterFns: (() => void)[] = []

  const addGuard = (guard: () => boolean | Promise<boolean>): void => {
    unregisterFns.push(registerWindowCloseGuard(guard))
  }

  beforeEach(() => {
    confirmWindowClose.mockClear()
    cancelWindowClose.mockClear()
    vi.mocked(toast.error).mockClear()
    // Without a rich close handler, dispatch uses only this preload fallback surface.
    const windowTarget = Object.assign(new EventTarget(), {
      api: { ui: { confirmWindowClose, cancelWindowClose } }
    })
    ;(globalThis as unknown as { window: typeof windowTarget }).window = windowTarget
  })

  afterEach(() => {
    setWindowCloseRequestHandler(null)
    unregisterFns.splice(0).forEach((fn) => fn())
    consumeShutdownCheckpointFailureReason()
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
    expect(cancelWindowClose).toHaveBeenCalledTimes(1)
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

  it('cancels the close — no confirm, no handler — when a guard vetoes', async () => {
    const handler = vi.fn()
    setWindowCloseRequestHandler(handler)
    addGuard(() => false)

    await dispatchWindowCloseRequest({ isQuitting: true })

    expect(confirmWindowClose).not.toHaveBeenCalled()
    expect(cancelWindowClose).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
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
    await dispatchWindowCloseRequest({ isQuitting: true })
    expect(guard).toHaveBeenCalledTimes(1)

    resolveGuard(true)
    await first
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })
})
