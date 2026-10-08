// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'

const WORKSPACE_PATH = '/Users/ada/repo'

const mockState = {
  settings: {},
  runtimeEnvironments: [],
  folderWorkspaces: {},
  projectGroups: [],
  repos: [],
  worktreesByRepo: {}
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: typeof mockState) => unknown) => select(mockState), {
    getState: () => ({ ...mockState, updateSettingsOrThrow: vi.fn() })
  })
}))

const activeWorktree = {
  id: 'repo--main',
  path: WORKSPACE_PATH,
  priorWorktreeIds: [],
  projectId: null,
  repoId: 'repo'
}
vi.mock('@/store/selectors', () => ({
  useActiveRepo: () => null,
  useActiveWorktree: () => activeWorktree,
  useActiveWorktreeId: () => activeWorktree.id,
  useAllWorktrees: () => [activeWorktree],
  useProjectHostSetupProjection: () => ({ projects: [], setups: [] }),
  useRepos: () => []
}))

function vaultSession(id: string, cwd: string): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: id,
    title: id,
    cwd,
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

// Two sessions in the active workspace, one elsewhere, and a scan that stopped
// at its depth of three — the shape #22480 reported as "1 of 502 sessions".
const sessions = [
  vaultSession('in-scope-1', WORKSPACE_PATH),
  vaultSession('in-scope-2', `${WORKSPACE_PATH}/packages/app`),
  vaultSession('elsewhere', '/Users/ada/other')
]
const scopeFullyScanned = { current: false }
vi.mock('./ai-vault-session-refresh', () => ({
  useAiVaultSessionRefresh: () => ({
    error: null,
    loading: false,
    refresh: vi.fn(),
    loadedSessionLimit: 3,
    scanResult: {
      sessions,
      issues: [],
      scannedAt: '2026-05-01T10:10:00.000Z',
      scopeFullyScanned: scopeFullyScanned.current
    },
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
// The virtualizer measures a zero-height viewport under happy-dom. Only the list
// bar and the Show more footer matter here, and both sit outside this component.
vi.mock('./AiVaultSessionVirtualList', () => ({
  AiVaultSessionVirtualList: ({ groups }: { groups: readonly AiVaultSessionListGroup[] }) => (
    <ul>
      {groups.flatMap((group) =>
        group.sessions.map((session) => <li key={session.id}>{session.title}</li>)
      )}
    </ul>
  )
}))

beforeEach(() => {
  scopeFullyScanned.current = false
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: { searchSessions: vi.fn() },
      ui: { writeClipboardText: vi.fn() }
    }
  })
})
afterEach(cleanup)

async function renderPanelOnWorkspaceTab(): Promise<void> {
  // Imported here, not at the top: the hoisted mock factories close over `sessions`.
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  render(<AiVaultPanel />)
  await userEvent.click(screen.getByRole('radio', { name: 'Workspace' }))
}

// Why: main measured the scope-filtered numerator against every session the scan
// loaded for the whole machine, so one in-scope session read "1 of 502 sessions".
it('counts the tab the user is on, not every session the machine holds', async () => {
  scopeFullyScanned.current = true
  await renderPanelOnWorkspaceTab()

  expect(screen.getByText('2 sessions')).toBeTruthy()
  expect(screen.queryByText('2 of 3 sessions')).toBeNull()
})

// Why: only Claude and Pi bucket transcripts by cwd. When the scanner cannot
// vouch for the scope, a deeper scan really does add in-scope rows, so hiding
// the control (and dropping the "+") would state something untrue.
it('offers Show more on a scoped tab the scanner did not vouch for', async () => {
  await renderPanelOnWorkspaceTab()

  expect(screen.getByRole('button', { name: 'Show more sessions' })).toBeTruthy()
  expect(screen.getByText('2+ sessions')).toBeTruthy()
})

it('drops Show more on a scoped tab the scanner reports as complete', async () => {
  scopeFullyScanned.current = true
  await renderPanelOnWorkspaceTab()

  expect(screen.queryByRole('button', { name: 'Show more sessions' })).toBeNull()
})

it('keeps Show more on All, where the depth always bounds the list', async () => {
  scopeFullyScanned.current = true
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  render(<AiVaultPanel />)
  await userEvent.click(screen.getByRole('radio', { name: 'All' }))

  expect(screen.getByRole('button', { name: 'Show more sessions' })).toBeTruthy()
  expect(screen.getByText('3+ sessions')).toBeTruthy()
})
