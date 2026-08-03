import { describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from './types'
import {
  createUpdaterQuitAbortRelay,
  prepareRendererForAppRestart
} from './renderer-restart-preparation'

describe('prepareRendererForAppRestart', () => {
  it('aborts when the dispatched shutdown checkpoint prevents unload', async () => {
    const eventTarget = new EventTarget()
    const started = vi.fn()
    const aborted = vi.fn()
    const checkpoint = vi.fn((event: Event) => event.preventDefault())
    eventTarget.addEventListener('restart-started', started)
    eventTarget.addEventListener('restart-aborted', aborted)
    eventTarget.addEventListener('beforeunload', checkpoint)

    await expect(
      prepareRendererForAppRestart(eventTarget, {
        startedEventName: 'restart-started',
        abortedEventName: 'restart-aborted'
      })
    ).rejects.toThrow('Renderer shutdown checkpoint was not completed.')

    expect(started).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
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
