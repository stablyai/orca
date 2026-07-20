import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createShutdownCheckpointBeforeUnloadHandler,
  createShutdownCheckpointGuard,
  preventUnloadAndScheduleShutdownCheckpointReset
} from './shutdown-checkpoint-guard'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../shared/renderer-shutdown-events'

describe('createShutdownCheckpointGuard', () => {
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
    guard.reset()
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

  it('retries after a prevented reload resets the completed checkpoint', () => {
    const eventTarget = new EventTarget()
    const persist = vi.fn()
    const guard = createShutdownCheckpointGuard(persist)
    const checkpoint = createShutdownCheckpointBeforeUnloadHandler(guard)
    const preventReload = (event: Event): void => event.preventDefault()
    eventTarget.addEventListener('beforeunload', checkpoint)
    eventTarget.addEventListener('beforeunload', preventReload)

    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    guard.reset()
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
    eventTarget.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, guard.reset)

    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    await Promise.resolve()
    eventTarget.removeEventListener('beforeunload', preventReload)
    expect(eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)

    expect(persist).toHaveBeenCalledTimes(2)
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
