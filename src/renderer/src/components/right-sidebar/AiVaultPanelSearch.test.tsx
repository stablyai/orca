// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchResults } from '../../../../shared/ai-vault-search-test-fixture'

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
    titleOnly: false,
    host: null,
    resetKey: 'all',
    ...overrides
  }
}

function renderPanel(search: PanelSearch, resultCount = 0) {
  return render(
    <AiVaultPanelSearch search={search} noAgents={false} resultCount={resultCount}>
      <div>results</div>
    </AiVaultPanelSearch>
  )
}

describe('AiVaultPanelSearch', () => {
  it('reports no matches only when tab-title matches are also absent', () => {
    const response = searchResults()
    const search = panelSearch({ hits: [], response: { ...response, hits: [] } })
    const { unmount } = renderPanel(search, 0)
    expect(screen.getByRole('status').textContent).toContain('No matching sessions')
    unmount()
    renderPanel(search, 1)
    expect(screen.queryByText(/No matching sessions/)).toBeNull()
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
