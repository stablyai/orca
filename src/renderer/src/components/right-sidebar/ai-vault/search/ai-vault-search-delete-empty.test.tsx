// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import type { AiVaultAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { searchResults } from '../../../../../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { useAiVaultSessionDeleteAction } from '../session-actions/ai-vault-session-delete-action'
import { AiVaultPanelSearch } from './AiVaultPanelSearch'
import { useAiVaultPanelSearch } from './use-ai-vault-search'

const state = {
  settings: { aiVaultSearch: { enabled: true, historyDays: null } },
  runtimeEnvironments: []
}
vi.mock('@/store/index', () => ({
  useAppStore: Object.assign((select: (current: typeof state) => unknown) => select(state), {
    getState: () => state
  })
}))
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
}))
const agents: AiVaultAgent[] = ['claude']
const refresh = async () => {}
const confirm = async () => true

function SearchWithDelete() {
  const search = useAiVaultPanelSearch('demo', agents, undefined, 'local', 'relevance')
  const requestDelete = useAiVaultSessionDeleteAction({ refresh, onDeleted: search.onDeleted })
  return (
    <AiVaultPanelSearch search={search} noAgents={false}>
      {search.sessions.map((session) => (
        <div key={session.id}>
          <span>{session.title}</span>
          <button onClick={() => void requestDelete(session)}>Delete demo session</button>
        </div>
      ))}
    </AiVaultPanelSearch>
  )
}

afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.unstubAllGlobals()
})

it('shows the empty status after deleting the last displayed search result', async () => {
  const response = searchResults()
  response.hits = [{ ...response.hits[0], agent: 'claude', title: 'Demo conversation' }]
  vi.stubGlobal('api', {
    aiVault: {
      searchSessions: async () => response,
      deleteSession: async () => ({ outcome: 'deleted' })
    }
  })
  render(
    <ConfirmationDialogContext.Provider value={confirm}>
      <SearchWithDelete />
    </ConfirmationDialogContext.Provider>
  )
  await screen.findByText('Demo conversation')
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Delete demo session' }))
  await waitFor(() => {
    expect(screen.queryByText('Demo conversation')).toBeNull()
    expect(screen.getByRole('status')).not.toBeNull()
  })
})
