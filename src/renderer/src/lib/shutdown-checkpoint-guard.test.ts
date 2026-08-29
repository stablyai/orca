// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createShutdownCheckpointBeforeUnloadHandler,
  createShutdownCheckpointGuard,
  preventUnloadAndScheduleShutdownCheckpointReset
} from './shutdown-checkpoint-guard'
import {
  consumeShutdownCheckpointFailureReason,
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT,
  ORCA_RENDERER_UNLOAD_PREVENTED_EVENT
} from '../../../shared/renderer-shutdown-events'

describe('createShutdownCheckpointGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { api?: unknown }).api
    consumeShutdownCheckpointFailureReason()
  })

  it('dedupes the synthetic and native unload events in one close attempt', () => {
    const persist = vi.fn()
    const guard = createShutdownCheckpointGuard(persist)

    expect(guard.persistOnce()).toBe(true)
    expect(guard.persistOnce()).toBe(true)

    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('allows a new checkpoint after an aborted restart resets the attempt', () => {
    const persist = vi.fn()
    const guard = createShutdownCheckpointGuard(persist)

    expect(guard.persistOnce()).toBe(true)
    guard.abandonAttempt()
    expect(guard.persistOnce()).toBe(true)

    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('retries when the blocking checkpoint throws', () => {
    const persist = vi.fn().mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const guard = createShutdownCheckpointGuard(persist)

    expect(guard.persistOnce()).toBe(false)
    expect(guard.persistOnce()).toBe(true)

    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('publishes the failure cause and records a crash breadcrumb (STA-5505)', () => {
    const recordBreadcrumb = vi.fn()
    ;(window as unknown as { api: unknown }).api = { crashReports: { recordBreadcrumb } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = createShutdownCheckpointGuard(() => {
      throw new Error('sendSync payload rejected')
    })

    expect(guard.persistOnce()).toBe(false)

    expect(consumeShutdownCheckpointFailureReason()).toBe('sendSync payload rejected')
    expect(recordBreadcrumb).toHaveBeenCalledWith({
      name: 'renderer_shutdown_checkpoint_failed',
      data: { message: 'sendSync payload rejected' }
    })
  })

  it('clears a stale failure cause once a later checkpoint succeeds (STA-5505)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = createShutdownCheckpointGuard(
      vi.fn().mockImplementationOnce(() => {
        throw new Error('disk full')
      })
    )

    expect(guard.persistOnce()).toBe(false)
    expect(guard.persistOnce()).toBe(true)

    expect(consumeShutdownCheckpointFailureReason()).toBeNull()
  })

  it('keeps failure reporting non-throwing for unstringifiable thrown values', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = createShutdownCheckpointGuard(() => {
      throw Object.create(null)
    })

    expect(guard.persistOnce()).toBe(false)
    expect(consumeShutdownCheckpointFailureReason()).toBe('Unknown shutdown checkpoint failure')
  })

  it('uses a fallback reason when an Error has an empty message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('placeholder')
    error.message = ''
    const guard = createShutdownCheckpointGuard(() => {
      throw error
    })

    expect(guard.persistOnce()).toBe(false)
    expect(consumeShutdownCheckpointFailureReason()).toBe('Unknown shutdown checkpoint failure')
  })

  it('resets state owned by the persist attempt lifecycle', () => {
    const abandonPersistAttempt = vi.fn()
    const guard = createShutdownCheckpointGuard(vi.fn(), abandonPersistAttempt)

    guard.abandonAttempt()

    expect(abandonPersistAttempt).toHaveBeenCalledTimes(1)
  })

  it('preserves persist retry state when the checkpoint itself aborts the restart', () => {
    const abandonPersistAttempt = vi.fn()
    const guard = createShutdownCheckpointGuard(vi.fn(), abandonPersistAttempt)

    guard.abortAfterCheckpointFailure()

    expect(abandonPersistAttempt).not.toHaveBeenCalled()
  })

  it('reports checkpoint failure separately from the unload verdict', () => {
    const eventTarget = new EventTarget()
    const failed = vi.fn()
    const guard = createShutdownCheckpointGuard(() => {
      throw new Error('invalid session')
    })
    eventTarget.addEventListener(ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT, failed)
    eventTarget.addEventListener('beforeunload', createShutdownCheckpointBeforeUnloadHandler(guard))

    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it('retries after a prevented reload resets the completed checkpoint', () => {
    const eventTarget = new EventTarget()
    const persist = vi.fn()
    const guard = createShutdownCheckpointGuard(persist)
    const checkpoint = createShutdownCheckpointBeforeUnloadHandler(guard)
    const preventReload = (event: Event): void => event.preventDefault()
    eventTarget.addEventListener('beforeunload', checkpoint)
    eventTarget.addEventListener('beforeunload', preventReload)

    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    guard.abandonAttempt()
    eventTarget.removeEventListener('beforeunload', preventReload)
    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)

    expect(persist).toHaveBeenCalledTimes(2)
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

  it('runs the quit checkpoint inside the window-close scope and surfaces a vetoed quit (STA-5505/#15352)', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/Terminal.tsx'),
      'utf8'
    )
    const closeStart = source.indexOf('const confirmNativeWindowClose = useCallback(() => {')
    const closeEnd = source.indexOf('window.api.ui.confirmWindowClose()', closeStart)
    expect(closeStart).toBeGreaterThanOrEqual(0)
    expect(closeEnd).toBeGreaterThan(closeStart)
    const closeBlock = source.slice(closeStart, closeEnd)
    // Why pin: without the scope, a persist failure blocks quit with no degradable
    // tier; without the toast, the vetoed quit is silent and SIGKILL-only (#15352).
    expect(closeBlock).toContain('runWithWindowCloseCheckpointScope(() =>')
    expect(closeBlock).toContain('showShutdownCheckpointFailureToast()')
  })

  it('wires dirty editor unload vetoes to the paired-web checkpoint reset', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/Terminal.tsx'),
      'utf8'
    )
    const dirtyGuardStart = source.indexOf(
      'const dirtyFiles = useAppStore.getState().openFiles.filter((f) => f.isDirty)'
    )
    const dirtyGuardEnd = source.indexOf("window.addEventListener('beforeunload', handler)")
    expect(dirtyGuardStart).toBeGreaterThanOrEqual(0)
    expect(dirtyGuardEnd).toBeGreaterThan(dirtyGuardStart)
    expect(source.slice(dirtyGuardStart, dirtyGuardEnd)).toContain(
      'preventUnloadAndScheduleShutdownCheckpointReset(e, window)'
    )
  })
})
