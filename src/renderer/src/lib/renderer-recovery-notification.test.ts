// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearRendererRecoveryNotificationPending,
  consumePendingRendererRecoveryNotification,
  markRendererRecoveryNotificationPending
} from './renderer-recovery-notification'

describe('renderer recovery notification markers', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores and consumes session-scoped renderer reload notifications once', () => {
    markRendererRecoveryNotificationPending('memory-pressure-reload', 'session')

    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'memory-pressure-reload'
    })
    expect(consumePendingRendererRecoveryNotification()).toBeNull()
  })

  it('prefers app restart notifications over stale renderer reload notifications', () => {
    markRendererRecoveryNotificationPending('lazy-chunk-reload', 'session')
    markRendererRecoveryNotificationPending('lazy-chunk-app-restart', 'local')

    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'lazy-chunk-app-restart'
    })
    expect(consumePendingRendererRecoveryNotification()).toBeNull()
  })

  it('clears only matching pending notifications when a recovery attempt is refused', () => {
    markRendererRecoveryNotificationPending('lazy-chunk-reload', 'session')
    markRendererRecoveryNotificationPending('lazy-chunk-app-restart', 'local')

    clearRendererRecoveryNotificationPending('lazy-chunk-app-restart')

    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'lazy-chunk-reload'
    })
  })

  it('prefers a fresh renderer reload notification over an older durable restart marker', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-24T12:00:00.000Z'))
    markRendererRecoveryNotificationPending('lazy-chunk-app-restart', 'local')

    vi.setSystemTime(new Date('2026-06-24T12:01:00.000Z'))
    markRendererRecoveryNotificationPending('memory-pressure-reload', 'session')

    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'memory-pressure-reload'
    })
    expect(consumePendingRendererRecoveryNotification()).toBeNull()
  })

  it('ignores expired durable restart notifications', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-24T12:00:00.000Z'))
    markRendererRecoveryNotificationPending('lazy-chunk-app-restart', 'local')

    vi.setSystemTime(new Date('2026-06-24T12:31:00.000Z'))

    expect(consumePendingRendererRecoveryNotification()).toBeNull()
  })
})
