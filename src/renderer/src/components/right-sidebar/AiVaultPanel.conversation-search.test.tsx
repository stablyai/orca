// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AiVaultPanel from './AiVaultPanel'
import { conversationSessions } from '../sidebar/ProjectConversationList.test-fixture'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

const state = {
  settings: { aiVaultSearch: { enabled: true } },
  runtimeEnvironments: [],
  folderWorkspaces: [],
  projectGroups: [],
  repos: [],
  endpointProjects: [],
  endpointProjectHostSetups: [],
  worktreesByRepo: {}
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
    getState: () => state
  })
}))
vi.mock('@/store/selectors', () => ({
  useActiveRepo: () => null,
  useActiveWorktree: () => null,
  useActiveWorktreeId: () => null,
  useAllWorktrees: () => [],
  useProjectHostSetupProjection: () => ({ projects: [], setups: [] }),
  useRepos: () => []
}))
const sessions: AiVaultSession[] = [
  {
    ...conversationSessions[0]!,
    source: 'structured-record' as const,
    messageCount: 0,
    title: 'Saved durable chat',
    firstUserPrompt: 'Find the distinctive journal marker',
    structuredSession: { sessionId: 'chat', workspaceId: 'folder:notes' }
  }
]
const observeRefresh = vi.hoisted(() => vi.fn())
vi.mock('./ai-vault-session-refresh', () => ({
  useAiVaultSessionRefresh: (_paths: string[], _scope: string, limit: number | 'unlimited') => {
    observeRefresh(limit)
    return {
      error: null,
      loading: false,
      refresh: vi.fn(),
      scanResult: { sessions, issues: [], scannedAt: 'now' },
      sessions,
      loadedSessionLimit: 100
    }
  }
}))
vi.mock('./use-persisted-ai-vault-view-options', () => ({
  usePersistedAiVaultViewOptions: () => ({
    agents: [],
    sort: 'updated',
    searchSort: 'relevance',
    group: 'project',
    hideEmptySessions: true,
    sessionLimit: 100,
    setSort: vi.fn(),
    setSearchSort: vi.fn(),
    setGroup: vi.fn(),
    setHideEmptySessions: vi.fn(),
    setSessionLimit: vi.fn(),
    setAgentEnabled: vi.fn(),
    setAllAgentsEnabled: vi.fn(),
    resetViewOptions: vi.fn()
  })
}))
vi.mock('../sidebar/ProjectConversationList', () => ({
  ProjectConversationList: ({ groups }: { groups: readonly AiVaultSessionListGroup[] }) => (
    <ul>
      {groups.flatMap((group) =>
        group.sessions.map((session) => <li key={session.id}>{session.title}</li>)
      )}
    </ul>
  )
}))
vi.mock('./ai-vault-session-delete-action', () => ({
  useAiVaultSessionDeleteAction: () => vi.fn()
}))
const searchSessions = vi.fn()
beforeEach(() => {
  searchSessions.mockReset().mockResolvedValue({
    kind: 'results',
    hits: [],
    page: { cursor: null, hasMore: false },
    generation: 1,
    durationMs: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions }, ui: { writeClipboardText: vi.fn() } }
  })
})
afterEach(cleanup)

it('keeps recoverable provider history with unknown content despite the saved empty-session filter', async () => {
  const unknown: AiVaultSession = {
    ...conversationSessions[0]!,
    id: 'provider-unknown',
    sessionId: 'provider-unknown',
    source: undefined,
    structuredSession: undefined,
    messageCount: 0,
    conversationContent: 'unknown',
    title: 'Recoverable provider history'
  }
  sessions.push(unknown)
  try {
    render(<AiVaultPanel conversationNavigation />)
    expect(screen.getByText('Recoverable provider history')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Search sessions'), 'Recoverable')
    await waitFor(() => expect(searchSessions).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('Recoverable provider history')).toBeTruthy())
  } finally {
    sessions.pop()
  }
})

it('shows primary project chats despite legacy hidden-agent filters and searches their durable prompts without an index hit', async () => {
  render(<AiVaultPanel conversationNavigation />)
  expect(observeRefresh).toHaveBeenLastCalledWith('unlimited')
  expect(screen.queryByText('Show more sessions')).toBeNull()
  expect(screen.getByText('Saved durable chat')).toBeTruthy()
  await userEvent.type(screen.getByLabelText('Search sessions'), 'distinctive')
  await waitFor(() => expect(searchSessions).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByText('Saved durable chat')).toBeTruthy())
  expect(
    screen.queryByText('No matching sessions in the indexed history. Try another query or scope.')
  ).toBeNull()
})
