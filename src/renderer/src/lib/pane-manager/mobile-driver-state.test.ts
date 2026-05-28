import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDriverForPty,
  hydrateDrivers,
  isPtyLocked,
  onDriverChange,
  setDriverForPty
} from './mobile-driver-state'

afterEach(() => {
  hydrateDrivers([])
})

describe('mobile-driver-state', () => {
  it('stores and clears driver state keyed by PTY id', () => {
    setDriverForPty('pty-1', { kind: 'mobile', clientId: 'phone-1' })

    expect(getDriverForPty('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-1' })
    expect(isPtyLocked('pty-1')).toBe(true)

    setDriverForPty('pty-1', { kind: 'idle' })

    expect(getDriverForPty('pty-1')).toEqual({ kind: 'idle' })
    expect(isPtyLocked('pty-1')).toBe(false)
  })

  it('hydrates driver snapshots and notifies affected listeners', () => {
    setDriverForPty('pty-old', { kind: 'mobile', clientId: 'phone-old' })
    const listener = vi.fn()
    const unsub = onDriverChange(listener)

    hydrateDrivers([{ ptyId: 'pty-new', driver: { kind: 'mobile', clientId: 'phone-new' } }])

    expect(getDriverForPty('pty-old')).toEqual({ kind: 'idle' })
    expect(getDriverForPty('pty-new')).toEqual({ kind: 'mobile', clientId: 'phone-new' })
    expect(listener).toHaveBeenCalledWith({
      ptyId: 'pty-old',
      driver: { kind: 'idle' }
    })
    expect(listener).toHaveBeenCalledWith({
      ptyId: 'pty-new',
      driver: { kind: 'mobile', clientId: 'phone-new' }
    })

    unsub()
  })
})
