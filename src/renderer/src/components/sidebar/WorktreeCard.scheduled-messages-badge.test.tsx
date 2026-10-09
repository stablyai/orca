// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const openModal = vi.fn()
const setRenamingWorktreeId = vi.fn()
const updateWorktreeMeta = vi.fn()
const testDoubles = vi.hoisted(() => ({
  activateWorktreeFromSidebar: vi.fn()
}))
const sleepMocks = vi.hoisted(() => ({
  sleeping: false
}))
let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'comment']
let settings: Partial<GlobalSettings> | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      browserTabsByWorktree: {},
      createBrowserTab: vi.fn(),
      deleteFolderWorkspace: vi.fn(),
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch: vi.fn(),
      fetchIssue: vi.fn(),
      fetchLinearIssue: vi.fn(),
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {},
      issueCache: {},
      linearIssueCache: {},
      openModal,
      openTaskPage: vi.fn(),
      projectGroups: [],
      ptyIdsByTabId: {},
      remoteBranchConflictByWorktreeId: {},
      renamingWorktreeId: null,
      setActiveWorktree: vi.fn(),
      setRemoteBrowserPageHandle: vi.fn(),
      setRenamingWorktreeId,
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      tabsByWorktree: {},
      updateWorktreeMeta,
      workspacePortScan: null,
      worktreeCardProperties
    })
}))

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: testDoubles.activateWorktreeFromSidebar
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => sleepMocks.sleeping
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => <div data-testid="inline-agents" />
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu-wrapper">{children}</div>
  ),
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

vi.mock('./WorktreeCardScheduledMessagesBadge', () => ({
  WorktreeCardScheduledMessagesBadge: () => <span data-testid="scheduled-badge" />
}))

vi.mock('./WorktreeTitleInlineRename', () => ({
  WorktreeTitleInlineRename: ({
    disabled,
    displayName
  }: {
    disabled?: boolean
    displayName: string
  }) => (
    <span data-testid="inline-rename" data-disabled={disabled ? 'true' : 'false'}>
      {displayName}
    </span>
  )
}))

import WorktreeCard from './WorktreeCard'

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/feature',
    repoId: 'repo-1',
    path: '/repo/worktrees/feature',
    displayName: 'Feature',
    branch: 'refs/heads/feature',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

describe('WorktreeCard scheduled-messages badge', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
    worktreeCardProperties = ['status', 'comment']
    settings = null
    sleepMocks.sleeping = false
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('renders beside the status slot, not inside its one-icon column', () => {
    act(() => {
      root.render(<WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />)
    })

    const statusSlot = container.querySelector('[data-worktree-card-status-slot]')
    const badge = container.querySelector('[data-testid="scheduled-badge"]')
    expect(statusSlot).not.toBeNull()
    expect(badge).not.toBeNull()
    expect(statusSlot?.contains(badge ?? null)).toBe(false)
    expect(badge?.parentElement?.hasAttribute('data-worktree-card-parent-content')).toBe(true)
  })
})
