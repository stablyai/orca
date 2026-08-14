import { describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from './update-status-types'
import { ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT } from './renderer-shutdown-events'
import {
  createUpdaterQuitAbortRelay,
  prepareRendererForAppRestart
} from './renderer-restart-preparation'

describe('prepareRendererForAppRestart', () => {
  it('aborts when the dispatched shutdown checkpoint reports failure', async () => {
    const eventTarget = new EventTarget()
    const started = vi.fn()
    const aborted = vi.fn()
    const checkpoint = vi.fn((event: Event) => {
      event.currentTarget?.dispatchEvent(new Event(ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT))
      event.preventDefault()
    })
    eventTarget.addEventListener('restart-started', started)
    eventTarget.addEventListener('restart-aborted', aborted)
    eventTarget.addEventListener('beforeunload', checkpoint)

    await expect(
      prepareRendererForAppRestart(eventTarget, {
        startedEventName: 'restart-started',
        abortedEventName: 'restart-aborted',
        awaitCheckpoint: () => Promise.resolve()
      })
    ).rejects.toThrow('Renderer shutdown checkpoint was not completed.')

    expect(started).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('does not mistake an unrelated unload veto for checkpoint failure', async () => {
    const eventTarget = new EventTarget()
    const veto = vi.fn((event: Event) => event.preventDefault())
    const awaitCheckpoint = vi.fn(() => Promise.resolve())
    eventTarget.addEventListener('beforeunload', veto)

    await prepareRendererForAppRestart(eventTarget, {
      startedEventName: 'restart-started',
      abortedEventName: 'restart-aborted',
      awaitCheckpoint
    })

    expect(veto).toHaveBeenCalledTimes(1)
    expect(awaitCheckpoint).toHaveBeenCalledTimes(1)
  })

  it('waits for the durable checkpoint write before the restart proceeds', async () => {
    const eventTarget = new EventTarget()
    const order: string[] = []
    let releaseCheckpoint!: () => void
    eventTarget.addEventListener('beforeunload', () => order.push('staged'))

    const prepared = prepareRendererForAppRestart(eventTarget, {
      startedEventName: 'restart-started',
      abortedEventName: 'restart-aborted',
      awaitCheckpoint: () =>
        new Promise<void>((resolve) => {
          order.push('awaiting-flush')
          releaseCheckpoint = () => {
            order.push('flushed')
            resolve()
          }
        })
    })
    let settled = false
    void prepared.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    releaseCheckpoint()
    await prepared
    expect(order).toEqual(['staged', 'awaiting-flush', 'flushed'])
  })

  it('aborts the restart when the staged state cannot be persisted', async () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('restart-aborted', aborted)

    await expect(
      prepareRendererForAppRestart(eventTarget, {
        startedEventName: 'restart-started',
        abortedEventName: 'restart-aborted',
        awaitCheckpoint: () => Promise.reject(new Error('Failed to persist renderer state.'))
      })
    ).rejects.toThrow('Failed to persist renderer state.')

    expect(aborted).toHaveBeenCalledTimes(1)
  })
})

describe('createUpdaterQuitAbortRelay', () => {
  it('resets a prepared update restart when async updater status reports failure', () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('update-restart-aborted', aborted)
    const relay = createUpdaterQuitAbortRelay(eventTarget, 'update-restart-aborted')
    relay.markPrepared()

    relay.handleStatus({ state: 'error', message: 'install failed' } satisfies UpdateStatus)
    relay.handleStatus({ state: 'error', message: 'duplicate failure' } satisfies UpdateStatus)

    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('resets a prepared restart on a linux package-install recovery status', () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('update-restart-aborted', aborted)
    const relay = createUpdaterQuitAbortRelay(eventTarget, 'update-restart-aborted')
    relay.markPrepared()

    relay.handleStatus({
      state: 'error',
      message: 'No authentication agent found.',
      recovery: {
        kind: 'linux-package-install',
        packageType: 'deb',
        reason: 'authentication-agent-unavailable',
        version: '1.0.61'
      }
    } satisfies UpdateStatus)

    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('ignores updater errors when no update restart was prepared', () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('update-restart-aborted', aborted)
    const relay = createUpdaterQuitAbortRelay(eventTarget, 'update-restart-aborted')

    relay.handleStatus({ state: 'error', message: 'check failed' } satisfies UpdateStatus)

    expect(aborted).not.toHaveBeenCalled()
  })
})
