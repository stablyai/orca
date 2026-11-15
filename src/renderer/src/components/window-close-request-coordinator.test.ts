// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { consumeShutdownCheckpointFailureReason } from '../../../shared/app-lifecycle/shutdown/renderer-shutdown-events'

import {
  prepareWindowCloseCheckpoint,
  setWindowCloseRequestHandler
} from './window-close-request-coordinator'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('window-close-request-coordinator', () => {
  const confirmWindowClose = vi.fn()
  const cancelWindowClose = vi.fn()
  const awaitBeforeUnloadCheckpoint = vi.fn(() => Promise.resolve())
  const unregisterFns: (() => void)[] = []

  beforeEach(() => {
    confirmWindowClose.mockClear()
    cancelWindowClose.mockClear()
    awaitBeforeUnloadCheckpoint.mockReset().mockResolvedValue(undefined)
    vi.mocked(toast.error).mockClear()
    // Without a rich close handler, dispatch uses only this preload fallback surface.
    const windowTarget = Object.assign(new EventTarget(), {
      api: { ui: { confirmWindowClose, cancelWindowClose }, app: { awaitBeforeUnloadCheckpoint } }
    })
    ;(globalThis as unknown as { window: typeof windowTarget }).window = windowTarget
  })

  afterEach(() => {
    setWindowCloseRequestHandler(null)
    unregisterFns.splice(0).forEach((fn) => fn())
    consumeShutdownCheckpointFailureReason()
  })

  it('counts one failed write once when a second close overlaps it', async () => {
    awaitBeforeUnloadCheckpoint.mockRejectedValueOnce(new Error('disk full'))

    const results = await Promise.all([
      prepareWindowCloseCheckpoint(),
      prepareWindowCloseCheckpoint()
    ])

    expect(results).toEqual([false, null])
    expect(awaitBeforeUnloadCheckpoint).toHaveBeenCalledTimes(1)
    // A later attempt stages its own write, which clears the failure.
    await expect(prepareWindowCloseCheckpoint()).resolves.toBe(true)
  })
})
