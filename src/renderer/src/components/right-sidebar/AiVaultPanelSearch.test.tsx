// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchResults } from '../../../../shared/ai-vault-search-test-fixture'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import { AiVaultPanelSearch } from './AiVaultPanelSearch'
import type { useAiVaultPanelSearch } from './use-ai-vault-search'

const store = vi.hoisted(() => ({
  settings: null,
  markFeatureTipsSeen: vi.fn(),
  updateSettingsOrThrow: vi.fn(async () => {})
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

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
    hasQuery: true,
    needsLocalConsent: false,
    hostSearchOff: false,
    host: null,
    resetKey: 'all',
    ...overrides
  }
}

function renderPanel(search: PanelSearch) {
  return render(
    <AiVaultPanelSearch search={search} noAgents={false}>
      <div>results</div>
    </AiVaultPanelSearch>
  )
}

describe('AiVaultPanelSearch', () => {
  it('notes title-only matching above the list for a host whose index is off', () => {
    renderPanel(panelSearch({ searching: false, hostSearchOff: true, host: 'ssh:build-box' }))

    expect(screen.getByRole('status').textContent).toContain('only session titles are matched')
    expect(screen.getByText('results')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

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

  it('says a computer does not have this workspace or project rather than blaming the search', () => {
    renderPanel(panelSearch({ response: { kind: 'unavailable', reason: 'scope-unknown' } }))

    expect(screen.getByRole('status').textContent).toContain(
      'does not have this workspace or project'
    )
  })

  it('stays quiet about computers that simply lack the scope while another searched it', () => {
    const response = searchResults()
    renderPanel(
      panelSearch({
        hits: response.hits,
        response: {
          ...response,
          hosts: [
            // Stale: it resolved the scope and searched, then the index moved.
            { executionHostId: 'local', outcome: 'stale' },
            { executionHostId: 'ssh:box', outcome: 'scope-unknown' }
          ]
        }
      })
    )

    expect(screen.getByRole('status').textContent).toBe(
      `Not searched: ${getExecutionHostLabel('local')} (index changed)`
    )
  })

  it('names the scope when it explains an empty result, because no computer had it', () => {
    const response = searchResults()
    renderPanel(
      panelSearch({
        hits: [],
        response: {
          ...response,
          hits: [],
          hosts: [
            { executionHostId: 'local', outcome: 'scope-unknown' },
            { executionHostId: 'ssh:box', outcome: 'scope-unknown' },
            // Unreachable explains nothing about the scope, so it does not silence it.
            { executionHostId: 'runtime:gone', outcome: 'unreachable' }
          ]
        }
      })
    )

    expect(screen.getByRole('status').textContent).toContain('box (scope not found there)')
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

  it('retires the session search tip when the user turns search on here', async () => {
    const search = panelSearch({ needsLocalConsent: true })
    renderPanel(search)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    })
    expect(store.markFeatureTipsSeen).toHaveBeenCalledWith(['agent-session-search'])
    expect(store.updateSettingsOrThrow).toHaveBeenCalledWith({
      aiVaultSearch: { enabled: true, historyDays: null }
    })
    expect(search.retry).toHaveBeenCalled()
  })
})
