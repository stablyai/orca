import { describe, expect, it } from 'vitest'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import { unavailableSessionSearchStatus } from '../../../../shared/ai-vault-search-client'
import { isSessionSearchIndexReady } from './session-history-status-copy'

function status(overrides: Partial<AiVaultSearchStatus>): AiVaultSearchStatus {
  return { ...unavailableSessionSearchStatus(), enabled: true, ...overrides }
}

describe('isSessionSearchIndexReady', () => {
  it('is ready once a whole sweep finished with nothing due', () => {
    expect(isSessionSearchIndexReady(status({ phase: 'current', lastSweepCompletedAt: 1 }))).toBe(
      true
    )
  })

  it('counts a finished sweep with unreadable files as ready', () => {
    expect(
      isSessionSearchIndexReady(
        status({ phase: 'degraded', filesFailed: 2, filesDue: 0, lastSweepCompletedAt: 1 })
      )
    ).toBe(true)
  })

  it('is not ready before the first sweep finishes', () => {
    expect(isSessionSearchIndexReady(null)).toBe(false)
    expect(isSessionSearchIndexReady(status({ phase: 'idle' }))).toBe(false)
    expect(isSessionSearchIndexReady(status({ phase: 'indexing', filesDue: 40 }))).toBe(false)
    // A degraded pass that has not completed a sweep yet is still building.
    expect(isSessionSearchIndexReady(status({ phase: 'degraded', filesFailed: 1 }))).toBe(false)
    expect(
      isSessionSearchIndexReady(status({ phase: 'degraded', filesDue: 3, lastSweepCompletedAt: 1 }))
    ).toBe(false)
  })

  it('is not ready while search is off', () => {
    expect(
      isSessionSearchIndexReady(
        status({ enabled: false, phase: 'current', lastSweepCompletedAt: 1 })
      )
    ).toBe(false)
  })
})
