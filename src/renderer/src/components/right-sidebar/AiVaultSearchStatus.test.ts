import { describe, expect, it } from 'vitest'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { aiVaultSearchCoverageStatus } from './AiVaultSearchStatus'

function coverage(overrides: Partial<AiVaultSearchCoverage> = {}): AiVaultSearchCoverage {
  return {
    sessionsIndexed: 1200,
    messagesIndexed: 48000,
    providers: [],
    backfill: 'complete',
    filesPending: 0,
    lastIndexedAt: '2026-09-01T11:00:00.000Z',
    ...overrides
  }
}

describe('aiVaultSearchCoverageStatus', () => {
  it('reports the indexed session count on its own', () => {
    expect(aiVaultSearchCoverageStatus(coverage())).toBe('Searching 1,200 sessions')
  })

  it('names the backfill and the pending-file backlog', () => {
    expect(aiVaultSearchCoverageStatus(coverage({ backfill: 'running', filesPending: 3 }))).toBe(
      'Searching 1,200 sessions · indexing older sessions… · 3 changed files pending'
    )
  })

  it('names a provider that discovered files but indexed nothing', () => {
    const status = aiVaultSearchCoverageStatus(
      coverage({
        providers: [
          { agent: 'claude', sessionsIndexed: 1200, messagesIndexed: 48000, filesDiscovered: 1200 },
          { agent: 'codex', sessionsIndexed: 0, messagesIndexed: 0, filesDiscovered: 42 }
        ]
      })
    )
    expect(status).toBe('Searching 1,200 sessions · Codex not indexed')
  })

  it('stays quiet while the backfill has not finished', () => {
    const status = aiVaultSearchCoverageStatus(
      coverage({
        backfill: 'running',
        providers: [{ agent: 'codex', sessionsIndexed: 0, messagesIndexed: 0, filesDiscovered: 42 }]
      })
    )
    expect(status).not.toContain('not indexed')
  })

  it('says nothing for a provider that discovered no files', () => {
    const status = aiVaultSearchCoverageStatus(
      coverage({ providers: [{ agent: 'codex', sessionsIndexed: 0, messagesIndexed: 0 }] })
    )
    expect(status).toBe('Searching 1,200 sessions')
  })
})
