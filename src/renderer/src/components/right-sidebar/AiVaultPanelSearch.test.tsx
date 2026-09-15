// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchResults } from '../../../../shared/ai-vault-search-test-fixture'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import { AiVaultPanelSearch } from './AiVaultPanelSearch'
import type { useAiVaultPanelSearch } from './use-ai-vault-search'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

afterEach(cleanup)

type PanelSearch = ReturnType<typeof useAiVaultPanelSearch>

function panelSearch(overrides: Partial<PanelSearch> = {}): PanelSearch {
  return {
    hits: [],
    response: null,
    error: false,
    loading: false,
    removeHit: vi.fn(),
    retry: vi.fn(),
    loadMore: vi.fn(),
    onDeleted: vi.fn(),
    sessions: [],
    searchHits: new Map(),
    searching: true,
    localConsent: false,
    host: null,
    resetKey: 'all',
    ...overrides
  }
}

function renderPanel(search: PanelSearch) {
  return render(
    <AiVaultPanelSearch search={search} noAgents={false} onDismiss={vi.fn()}>
      <div>results</div>
    </AiVaultPanelSearch>
  )
}

describe('AiVaultPanelSearch', () => {
  it('names every computer the merge could not search, with its reason', () => {
    const response = searchResults()
    renderPanel(
      panelSearch({
        hits: response.hits,
        response: {
          ...response,
          hosts: [
            { executionHostId: 'local', outcome: 'disabled' },
            { executionHostId: 'ssh:build-box', outcome: 'unreachable' },
            { executionHostId: 'runtime:cloud', outcome: 'searched' },
            { executionHostId: 'runtime:paused', outcome: 'not-ready' },
            { executionHostId: 'ssh:moved', outcome: 'stale' },
            { executionHostId: 'ssh:old', outcome: 'no-service' }
          ]
        }
      })
    )

    expect(screen.getByRole('status').textContent).toBe(
      `Not searched: ${getExecutionHostLabel('local')} (search off) · build-box (unreachable) · paused (not ready) · moved (index changed) · old (unavailable)`
    )
  })

  it('stays silent when every computer answered', () => {
    const response = searchResults()
    renderPanel(
      panelSearch({
        hits: response.hits,
        response: {
          ...response,
          hosts: [{ executionHostId: 'local', outcome: 'searched' }]
        }
      })
    )

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('results')).toBeTruthy()
  })

  it('no longer asks the user to choose one computer before searching', () => {
    renderPanel(panelSearch({ host: null }))

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/choose one computer/i)).toBeNull()
    expect(screen.getByText('results')).toBeTruthy()
  })
})
