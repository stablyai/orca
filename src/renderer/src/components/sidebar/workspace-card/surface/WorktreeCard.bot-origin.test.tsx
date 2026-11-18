import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

vi.mock('@/store', () => {
  const getState = () => ({
    deleteStateByWorktreeId: {},
    fetchHostedReviewForBranch: vi.fn(),
    fetchIssue: vi.fn(),
    fetchLinearIssue: vi.fn(),
    gitConflictOperationByWorktree: {},
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    openModal: vi.fn(),
    projectGroups: [],
    remoteBranchConflictByWorktreeId: {},
    settings: { compactWorktreeCards: false },
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    updateWorktreeMeta: vi.fn(),
    workspacePortScan: null,
    worktreeCardProperties: ['status', 'cli']
  })
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState,
      subscribe: () => () => {}
    })
  }
})

// Every card here is a bot's workspace; the card decides whether to ask for its bot.
vi.mock('@/components/bots/use-worktree-bot', () => ({
  useWorktreeBot: (_worktree: unknown, enabled: boolean) =>
    enabled ? { id: 'bot-1', name: 'Scout', avatar: null } : null
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('../activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))

vi.mock('../../workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false,
  selectIsSleepingWorktree: () => false
}))

vi.mock('../activity/CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('../activity/worktree-card-line-agents', () => ({ WorktreeCardLineAgents: () => null }))
vi.mock('../activity/worktree-card-line-agent-more', () => ({
  WorktreeCardLineAgentMore: () => null
}))

vi.mock('../activity/useWorktreeAgentRows', () => ({ useWorktreeAgentRows: () => [] }))
vi.mock('../activity/WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('../../workspace-actions/context-menu/WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope'
}))

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#999999',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'repo-1::/repo/worktrees/scout',
  repoId: 'repo-1',
  path: '/repo/worktrees/scout',
  displayName: 'test-workspace-scout',
  branch: 'scout',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  cliProvenance: { kind: 'created-by-cli', createdAt: 1 }
}

describe("WorktreeCard for a bot's workspace", () => {
  it('shows the bot, not the CLI mark, on its project row', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={repo} isActive={false} />
    )

    expect(markup).toContain('Made by Scout')
    expect(markup).not.toContain('Created by Orca CLI')
  })

  it("leaves the bot's avatar off its line under the bot", async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={repo} isActive={false} compactLine />
    )

    expect(markup).not.toContain('Made by Scout')
    expect(markup).not.toContain('Created by Orca CLI')
  })
})
