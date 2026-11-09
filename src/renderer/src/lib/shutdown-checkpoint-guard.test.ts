// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createShutdownCheckpointBeforeUnloadHandler,
  createShutdownCheckpointGuard,
  preventUnloadAndScheduleShutdownCheckpointReset
} from './shutdown-checkpoint-guard'
import {
  consumeShutdownCheckpointFailureReason,
  ORCA_RENDERER_UNLOAD_PREVENTED_EVENT
} from '../../../shared/renderer-shutdown-events'

describe('createShutdownCheckpointGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { api?: unknown }).api
    consumeShutdownCheckpointFailureReason()
  })

  it('keeps failure reporting non-throwing for unstringifiable thrown values', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = createShutdownCheckpointGuard(() => {
      throw Object.create(null)
    })

    expect(guard.persistOnce()).toBe(false)
    expect(consumeShutdownCheckpointFailureReason()).toBe('Unknown shutdown checkpoint failure')
  })

  it('reports only browser-initiated unloads vetoed by checkpoint failure (#21017)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const eventTarget = new EventTarget()
    const onNativeUnloadVetoed = vi.fn()
    const guard = createShutdownCheckpointGuard(() => {
      throw new Error('stage rejected')
    })
    eventTarget.addEventListener(
      'beforeunload',
      createShutdownCheckpointBeforeUnloadHandler(guard, onNativeUnloadVetoed)
    )

    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    expect(onNativeUnloadVetoed).not.toHaveBeenCalled()

    const reload = new Event('beforeunload', { cancelable: true })
    // Electron's reloadIgnoringCache dispatches a trusted beforeunload; synthetic close/restart dispatches are untrusted.
    Object.defineProperty(reload, 'isTrusted', { value: true })
    expect(eventTarget.dispatchEvent(reload)).toBe(false)
    expect(onNativeUnloadVetoed).toHaveBeenCalledTimes(1)
  })

  it('cancels unload when persistence fails and remains retryable', () => {
    const eventTarget = new EventTarget()
    const persist = vi.fn().mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const guard = createShutdownCheckpointGuard(persist)
    const checkpoint = createShutdownCheckpointBeforeUnloadHandler(guard)
    eventTarget.addEventListener('beforeunload', checkpoint)

    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)

    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('resets after a paired-web dirty-file veto regardless of listener order', async () => {
    const eventTarget = new EventTarget()
    const persist = vi.fn()
    const guard = createShutdownCheckpointGuard(persist)
    const preventReload = (event: Event): void => {
      preventUnloadAndScheduleShutdownCheckpointReset(event, eventTarget)
    }
    eventTarget.addEventListener('beforeunload', preventReload)
    eventTarget.addEventListener('beforeunload', createShutdownCheckpointBeforeUnloadHandler(guard))
    eventTarget.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, guard.abandonAttempt)

    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    await Promise.resolve()
    eventTarget.removeEventListener('beforeunload', preventReload)
    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)

    expect(persist).toHaveBeenCalledTimes(2)
  })
})
