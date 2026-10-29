// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import {
  markInputQuietSchedulerInput,
  resetInputQuietSchedulerForTest
} from '@/lib/input-quiet-scheduler'
import { AiVaultSessionPublicationGate } from './ai-vault-session-publication-gate'

const FIRST: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-08-09T00:00:00.000Z'
}
const SECOND: AiVaultListResult = {
  ...FIRST,
  scannedAt: '2026-08-09T00:00:01.000Z'
}

beforeEach(() => {
  vi.useFakeTimers()
  resetInputQuietSchedulerForTest()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AiVaultSessionPublicationGate', () => {
  it('publishes immediately when terminal input is already quiet', () => {
    const apply = vi.fn()

    new AiVaultSessionPublicationGate().publish(FIRST, apply)

    expect(apply).toHaveBeenCalledWith(FIRST)
  })

  it('retains only the newest result while input is active', () => {
    const apply = vi.fn()
    const gate = new AiVaultSessionPublicationGate()
    markInputQuietSchedulerInput()

    gate.publish(FIRST, apply)
    gate.publish(SECOND, apply)
    vi.advanceTimersByTime(101)

    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith(SECOND)
  })

  it('publishes by one second even when input never becomes quiet', () => {
    const apply = vi.fn()
    const gate = new AiVaultSessionPublicationGate()
    markInputQuietSchedulerInput()
    gate.publish(FIRST, apply)

    for (let elapsed = 90; elapsed < 1_000; elapsed += 90) {
      vi.advanceTimersByTime(90)
      markInputQuietSchedulerInput()
    }
    vi.advanceTimersByTime(10)

    expect(apply).toHaveBeenCalledWith(FIRST)
  })

  it('cancels a pending publication on scope change or unmount', () => {
    const apply = vi.fn()
    const gate = new AiVaultSessionPublicationGate()
    markInputQuietSchedulerInput()
    gate.publish(FIRST, apply)

    gate.cancel()
    vi.advanceTimersByTime(1_000)

    expect(apply).not.toHaveBeenCalled()
  })
})
