// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import {
  AiVaultSearchStatus,
  aiVaultSearchCoverageStatus,
  aiVaultSearchRepairedStatus
} from './AiVaultSearchStatus'

afterEach(cleanup)

function coverage(overrides: Partial<AiVaultSearchCoverage> = {}): AiVaultSearchCoverage {
  return {
    enabled: true,
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
  it('reports what is searchable while the backfill runs and the box is empty', () => {
    expect(
      aiVaultSearchCoverageStatus(coverage({ backfill: 'running' }), {
        hitCount: 0,
        hasQuery: false
      })
    ).toBe('1,200 conversations searchable · preparing older ones…')
  })

  it('says nothing once the backfill is done and the box is empty', () => {
    expect(aiVaultSearchCoverageStatus(coverage(), { hitCount: 0, hasQuery: false })).toBeNull()
  })

  it('warns that a query answered mid-backfill is incomplete', () => {
    expect(
      aiVaultSearchCoverageStatus(coverage({ backfill: 'running' }), {
        hitCount: 12,
        hasQuery: true
      })
    ).toBe('12 matching · still preparing')
  })

  it('reports matches against the covered corpus once the backfill is done', () => {
    expect(aiVaultSearchCoverageStatus(coverage(), { hitCount: 7, hasQuery: true })).toBe(
      '7 matching · 1,200 conversations'
    )
  })
})

describe('aiVaultSearchRepairedStatus', () => {
  it('names the corrected words so a wrong guess is visible', () => {
    expect(aiVaultSearchRepairedStatus(['coalesces'])).toBe('Showing results for coalesces ·')
  })

  it('says nothing when the query ran as typed', () => {
    expect(aiVaultSearchRepairedStatus([])).toBeNull()
  })
})

describe('AiVaultSearchStatus', () => {
  function renderStatus(props: Partial<Parameters<typeof AiVaultSearchStatus>[0]> = {}) {
    return render(
      <AiVaultSearchStatus
        coverage={coverage()}
        hitCount={7}
        hasQuery={true}
        newestFirst={false}
        onNewestFirstChange={() => undefined}
        {...props}
      />
    )
  }

  it('says which hits the host could not verify the source of', () => {
    renderStatus({ sourceUnavailableFiles: 3 })
    // Why: those hits are returned and rendered, so the count is the only thing that
    // distinguishes them from a hit whose transcript was stat-ed successfully.
    expect(screen.getByText('3 sources could not be verified')).toBeTruthy()
  })

  it('stays quiet when every hit had a verified source', () => {
    renderStatus({ sourceUnavailableFiles: 0 })
    expect(screen.queryByText(/could not be verified/)).toBeNull()
  })

  it('does not count unverified sources when no query is running', () => {
    renderStatus({ hasQuery: false, sourceUnavailableFiles: 3 })
    expect(screen.queryByText(/could not be verified/)).toBeNull()
  })
})
