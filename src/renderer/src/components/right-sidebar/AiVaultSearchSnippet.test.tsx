// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { AiVaultSearchEvidenceLine, aiVaultSearchSnippetSegments } from './AiVaultSearchSnippet'
import { aiVaultSearchCoverageStatus } from './AiVaultSearchStatus'

afterEach(cleanup)

const coverage = (overrides: Partial<AiVaultSearchCoverage> = {}): AiVaultSearchCoverage => ({
  sessionsIndexed: 1240,
  messagesIndexed: 0,
  providers: [],
  backfill: 'idle',
  filesPending: 0,
  lastIndexedAt: null,
  ...overrides
})

describe('aiVaultSearchSnippetSegments', () => {
  it('splits a snippet on its match markers', () => {
    expect(aiVaultSearchSnippetSegments('fix the [strict] mode [bug]')).toEqual([
      { text: 'fix the ', matched: false },
      { text: 'strict', matched: true },
      { text: ' mode ', matched: false },
      { text: 'bug', matched: true }
    ])
  })

  it('leaves an unmarked snippet as one plain segment', () => {
    expect(aiVaultSearchSnippetSegments('no markers here')).toEqual([
      { text: 'no markers here', matched: false }
    ])
  })
})

describe('AiVaultSearchEvidenceLine', () => {
  it('renders the role and marks the matched terms', () => {
    render(
      <AiVaultSearchEvidenceLine
        evidence={{ role: 'user', timestamp: null, snippet: 'fix the [strict] mode' }}
      />
    )
    expect(screen.getByText('You')).toBeTruthy()
    expect(screen.getByText('strict').className).toContain('bg-amber-500/30')
  })

  it('renders nothing without a snippet', () => {
    const { container } = render(
      <AiVaultSearchEvidenceLine evidence={{ role: 'assistant', timestamp: null, snippet: '' }} />
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('aiVaultSearchCoverageStatus', () => {
  it('reports the indexed corpus size', () => {
    expect(aiVaultSearchCoverageStatus(coverage())).toBe('Searching 1,240 sessions')
  })

  it('says older sessions are still being indexed while the backfill runs', () => {
    expect(aiVaultSearchCoverageStatus(coverage({ backfill: 'running' }))).toBe(
      'Searching 1,240 sessions · indexing older sessions…'
    )
  })

  it('reports files the index has not re-read yet', () => {
    expect(aiVaultSearchCoverageStatus(coverage({ filesPending: 7 }))).toBe(
      'Searching 1,240 sessions · 7 changed files pending'
    )
  })
})
