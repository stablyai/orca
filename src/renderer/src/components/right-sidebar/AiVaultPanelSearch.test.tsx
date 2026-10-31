// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

function renderPanel(search: PanelSearch) {
  return render(
    <AiVaultPanelSearch search={search} noAgents={false}>
      <div>results</div>
    </AiVaultPanelSearch>
  )
}

describe('AiVaultPanelSearch', () => {
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
