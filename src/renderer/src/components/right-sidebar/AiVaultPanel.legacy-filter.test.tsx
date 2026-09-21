// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSessionGroup } from './ai-vault-session-filters'

const mockState: {
  settings: { aiVaultSearch?: { enabled: boolean } }
  runtimeEnvironments: never[]
  folderWorkspaces: Record<string, never>
  projectGroups: never[]
  repos: never[]
  worktreesByRepo: Record<string, never>
} = {
  settings: {},
  runtimeEnvironments: [],
  folderWorkspaces: {},
  projectGroups: [],
  repos: [],
  worktreesByRepo: {}
}
const updateSettingsOrThrow = vi.fn(async (next: { aiVaultSearch: { enabled: boolean } }) => {
  mockState.settings = next
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: typeof mockState) => unknown) => select(mockState), {
    getState: () => ({ ...mockState, updateSettingsOrThrow })
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
  vaultSession('claude:1', 'Fix the foo pipeline'),
  vaultSession('claude:2', 'Rename the bar widget')
]
vi.mock('./ai-vault-session-refresh', () => ({
  useAiVaultSessionRefresh: () => ({
    error: null,
    loading: false,
    refresh: vi.fn(),
    scanResult: { sessions, issues: [], scannedAt: '2026-05-01T10:10:00.000Z' },
    sessions
  })
}))
vi.mock('./ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: () => ({
    buildResumeStartup: vi.fn(),
    copyResumeCommand: vi.fn(),
    handleResume: vi.fn(),
    handleResumeInNewChat: vi.fn(),
    handleContinueInNewSession: vi.fn(),
    continuationRequest: null,
    handleContinuationDialogOpenChange: vi.fn()
  })
}))
vi.mock('./ai-vault-original-pane-actions', () => ({
  useAiVaultOriginalPaneActions: () => ({
    getOriginalPaneTarget: vi.fn(),
    getSessionLiveState: vi.fn(),
    jumpToOriginalPane: vi.fn(),
    jumpToWorktree: vi.fn()
  })
}))
vi.mock('./ai-vault-session-delete-action', () => ({
  useAiVaultSessionDeleteAction: () => vi.fn()
}))
// The virtualizer measures a zero-height viewport under happy-dom; the rows it would
// choose are exactly the grouped sessions, so render those instead.
vi.mock('./AiVaultSessionVirtualList', () => ({
  AiVaultSessionVirtualList: ({ groups }: { groups: readonly AiVaultSessionGroup[] }) => (
    <ul>
      {groups.flatMap((group) =>
        group.sessions.map((session) => <li key={session.id}>{session.title}</li>)
      )}
    </ul>
  )
}))

const searchSessions = vi.fn()

function vaultSession(id: string, title: string): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: id,
    title,
    cwd: '/Users/ada/repo',
    branch: null,
    model: null,
    filePath: `/Users/ada/.claude/${id}.jsonl`,
    codexHome: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:10:00.000Z',
    modifiedAt: '2026-05-01T10:10:00.000Z',
    messageCount: 4,
    totalTokens: 10,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume',
    subagent: null
  }
}

beforeEach(() => {
  mockState.settings = {}
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

async function typeQuery(text: string) {
  // Imported here, not at the top: the hoisted mock factories close over `mockState` and `sessions`.
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  render(<AiVaultPanel />)
  if (text) {
    await userEvent.type(screen.getByLabelText('Search sessions'), text)
  }
}

it('offers indexing above the title-filtered history instead of hiding every session', async () => {
  await typeQuery('foo')

  expect(screen.getByRole('status').textContent).toContain('Enable full-text search?')
  expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
  expect(screen.getByText('Fix the foo pipeline')).toBeTruthy()
  expect(screen.queryByText('Rename the bar widget')).toBeNull()
  expect(searchSessions).not.toHaveBeenCalled()
})

it('switches to index search with the same query once indexing is enabled', async () => {
  await typeQuery('foo')

  await userEvent.click(screen.getByRole('button', { name: 'Enable' }))

  expect(updateSettingsOrThrow).toHaveBeenCalledWith({
    aiVaultSearch: { enabled: true, historyDays: null }
  })
  await waitFor(() =>
    expect(searchSessions).toHaveBeenCalledWith(expect.objectContaining({ query: 'foo' }), 'local')
  )
  expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  // The index answered with no hits, so the title filter's own row must not linger.
  await waitFor(() => expect(screen.queryByText('Fix the foo pipeline')).toBeNull())
})

it('shows the whole history and no offer while the box is empty', async () => {
  await typeQuery('')

  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  expect(screen.getByText('Fix the foo pipeline')).toBeTruthy()
  expect(screen.getByText('Rename the bar widget')).toBeTruthy()
  expect(searchSessions).not.toHaveBeenCalled()
})
