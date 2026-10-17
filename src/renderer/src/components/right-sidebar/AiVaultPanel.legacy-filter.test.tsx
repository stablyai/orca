// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const worktrees = [
  makeWorktree({
    id: 'workspace-a',
    repoId: 'repo-1',
    projectId: 'project-1',
    path: '/Users/ada/repo'
  }),
  makeWorktree({
    id: 'workspace-b',
    repoId: 'repo-1',
    projectId: 'project-1',
    path: '/Users/ada/other'
  }),
  makeWorktree({
    id: 'workspace-c',
    repoId: 'repo-2',
    projectId: 'project-2',
    path: '/Users/ada/third'
  })
]
let activeWorktree: Worktree | null = null

const mockState: {
  settings: { aiVaultSearch?: { enabled: boolean } }
  runtimeEnvironments: never[]
  folderWorkspaces: never[]
  projectGroups: never[]
  repos: never[]
  worktreesByRepo: Record<string, never>
} = {
  settings: {},
  runtimeEnvironments: [],
  folderWorkspaces: [],
  projectGroups: [],
  repos: [],
  worktreesByRepo: {}
}
const updateSettingsOrThrow = vi.fn(async (next: { aiVaultSearch: { enabled: boolean } }) => {
  mockState.settings = next
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: typeof mockState) => unknown) => select(mockState), {
    getState: () => ({ ...mockState, updateSettingsOrThrow, markFeatureTipsSeen: vi.fn() })
  })
}))
vi.mock('@/store/selectors', () => ({
  useActiveRepo: () => null,
  useActiveWorktree: () => activeWorktree,
  useActiveWorktreeId: () => activeWorktree?.id ?? null,
  useAllWorktrees: () => worktrees,
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
  AiVaultSessionVirtualList: ({ groups }: { groups: readonly AiVaultSessionListGroup[] }) => (
    // A null label is what tells the real list to render this group's rows without a header.
    <ul data-group-labels={groups.map((group) => group.label ?? '(untitled)').join('|')}>
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
  activeWorktree = null
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
  // The same bar serves both modes; browsing it reports the history counts and its own sort.
  expect(screen.getByText('2 sessions')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sort sessions: Last updated' })).toBeTruthy()
  expect(screen.queryByText('2 results')).toBeNull()
  expect(screen.queryByRole('button', { name: /^Sort results:/ })).toBeNull()
})

it('keeps sort off the filter menu, which is filters only', async () => {
  await typeQuery('')

  await userEvent.click(screen.getByRole('button', { name: 'Session History view options' }))

  expect(await screen.findByRole('menuitem', { name: 'Select all' })).toBeTruthy()
  expect(screen.queryByText('Sort')).toBeNull()
  expect(screen.queryByRole('menuitemradio', { name: 'Last updated' })).toBeNull()
  expect(screen.queryByRole('menuitemradio', { name: 'Created' })).toBeNull()
})

it('puts the hit count and the search sort on the same bar once the index answers', async () => {
  mockState.settings = { aiVaultSearch: { enabled: true } }
  searchSessions.mockResolvedValue({
    kind: 'results',
    hits: [
      {
        agent: 'claude',
        sessionId: 'claude:1',
        title: 'Fix the foo pipeline',
        cwd: '/Users/ada/repo',
        branch: null,
        updatedAt: '2026-05-01T10:10:00.000Z',
        messageCount: 4,
        score: 1,
        source: { presence: 'present', filePath: '/Users/ada/.claude/claude:1.jsonl' },
        evidence: null
      }
    ],
    page: { cursor: null, hasMore: false },
    generation: 1,
    durationMs: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false }
  })

  await typeQuery('foo')

  await waitFor(() => expect(screen.getByText('1 result')).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Sort results: Most relevant' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Sort sessions:/ })).toBeNull()
})

it('hands the list one untitled group while searching, and titled groups while browsing', async () => {
  mockState.settings = { aiVaultSearch: { enabled: true } }
  searchSessions.mockResolvedValue({
    kind: 'results',
    hits: [
      {
        agent: 'claude',
        sessionId: 'claude:1',
        title: 'Fix the foo pipeline',
        cwd: '/Users/ada/repo',
        branch: null,
        updatedAt: '2026-05-01T10:10:00.000Z',
        messageCount: 4,
        score: 1,
        source: { presence: 'present', filePath: '/Users/ada/.claude/claude:1.jsonl' },
        evidence: null
      }
    ],
    page: { cursor: null, hasMore: false },
    generation: 1,
    durationMs: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false }
  })

  await typeQuery('')
  const browsing = screen.getByRole('list').getAttribute('data-group-labels')
  expect(browsing).not.toContain('(untitled)')
  expect(browsing).toBeTruthy()

  await userEvent.type(screen.getByLabelText('Search sessions'), 'foo')

  await waitFor(() =>
    expect(screen.getByRole('list').getAttribute('data-group-labels')).toBe('(untitled)')
  )
})

it.each([
  { scope: 'All', target: 1 },
  { scope: 'All', target: 2 },
  { scope: 'Project', target: 1 }
])('preserves the $scope list when switching to workspace $target', async ({ scope, target }) => {
  activeWorktree = worktrees[0]
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  const { rerender } = render(<AiVaultPanel />)
  await userEvent.click(screen.getByRole('radio', { name: scope }))
  const list = screen.getByRole('list')
  list.scrollTop = 810

  activeWorktree = worktrees[target]
  rerender(<AiVaultPanel />)

  expect(screen.getByRole('list')).toBe(list)
  expect(screen.getByRole('list').scrollTop).toBe(810)
})

it.each(['Workspace', 'Project'])('resets the %s list when its subject changes', async (scope) => {
  activeWorktree = worktrees[0]
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  const { rerender } = render(<AiVaultPanel />)
  await userEvent.click(screen.getByRole('radio', { name: scope }))
  const list = screen.getByRole('list')
  list.scrollTop = 810

  activeWorktree = scope === 'Workspace' ? worktrees[1] : worktrees[2]
  rerender(<AiVaultPanel />)

  expect(screen.getByRole('list')).not.toBe(list)
  expect(screen.getByRole('list').scrollTop).toBe(0)
})

it('rebuilds the list when switching from All to Workspace', async () => {
  activeWorktree = worktrees[0]
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  render(<AiVaultPanel />)
  await userEvent.click(screen.getByRole('radio', { name: 'All' }))
  const list = screen.getByRole('list')
  list.scrollTop = 810

  await userEvent.click(screen.getByRole('radio', { name: 'Workspace' }))

  expect(screen.getByRole('list')).not.toBe(list)
  expect(screen.getByRole('list').scrollTop).toBe(0)
})

it('rebuilds Project when the same workspace moves to another project', async () => {
  activeWorktree = worktrees[0]
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  const { rerender } = render(<AiVaultPanel />)
  await userEvent.click(screen.getByRole('radio', { name: 'Project' }))
  const list = screen.getByRole('list')
  list.scrollTop = 810

  activeWorktree = { ...activeWorktree, projectId: 'project-2' }
  rerender(<AiVaultPanel />)

  expect(screen.getByRole('list')).not.toBe(list)
  expect(screen.getByRole('list').scrollTop).toBe(0)
})
