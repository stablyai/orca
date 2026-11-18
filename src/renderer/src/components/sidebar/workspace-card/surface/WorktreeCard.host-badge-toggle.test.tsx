import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WorktreeCardProperty } from '../../../../../../shared/ui-chrome/ui-chrome-types'
import type { WorktreeCardProps } from '../controller/worktree-card-model'
import type { Worktree } from '../../../../../../shared/worktree/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

const HOST_LABEL = 'gpu-vm'
let worktreeCardProperties: WorktreeCardProperty[] = []
let settings: Partial<GlobalSettings> | null = null
let runtimeEnvironments: readonly object[] = []

vi.mock('@/store', () => {
  const getState = () => ({
    deleteStateByWorktreeId: {},
    fetchHostedReviewForBranch,
    fetchIssue,
    fetchLinearIssue,
    gitConflictOperationByWorktree: {},
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    openModal,
    projectGroups: [],
    remoteBranchConflictByWorktreeId: {},
    runtimeEnvironments,
    settings,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    updateWorktreeMeta,
    workspacePortScan: null,
    worktreeCardProperties
  })
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState,
      subscribe: () => () => {}
    })
  }
})

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

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    repoIcon: { type: 'emoji', emoji: '🦊' },
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/host',
    repoId: 'repo-1',
    path: '/repo/worktrees/host',
    displayName: 'Host tree',
    branch: 'feature/host',
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
    ...overrides
  }
}

// Seed mocked store state before importing the card that reads it.
async function renderCardMarkup(props: Partial<WorktreeCardProps> = {}): Promise<string> {
  const { default: WorktreeCard } = await import('./WorktreeCard')
  return renderToStaticMarkup(
    <WorktreeCard
      worktree={makeWorktree()}
      repo={makeRepo()}
      isActive={false}
      hostContextLabel={HOST_LABEL}
      {...props}
    />
  )
}

describe('WorktreeCard host badge toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = []
    runtimeEnvironments = []
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
  })

  it("drops the CLI mark from a bot's workspace line and keeps it on ordinary cards", async () => {
    worktreeCardProperties = ['status', 'cli']
    const worktree = makeWorktree({ cliProvenance: { kind: 'created-by-cli', createdAt: 1 } })

    expect(await renderCardMarkup({ worktree })).toContain('Created by Orca CLI')
    const line = await renderCardMarkup({ worktree, compactLine: true })
    expect(line).not.toContain('Created by Orca CLI')
    expect(line).toMatch(/>orca<\/span>/)
  })
})
