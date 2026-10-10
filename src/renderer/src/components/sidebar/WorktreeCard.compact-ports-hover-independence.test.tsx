// @vitest-environment happy-dom

import React, { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const replaceWorkspacePortScans = vi.fn()
const setWorkspacePortScanRefreshing = vi.fn()
const cacheTimerMocks = vi.hoisted(() => ({
  usePromptCacheCountdownStartedAt: vi.fn()
}))

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'ports']
let settings: Partial<GlobalSettings> | null = { compactWorktreeCards: true }

vi.mock('@/store', () => {
  const getState = () => ({
    browserTabsByWorktree: {},
    agentActivityDisplayMode: undefined,
    createBrowserTab: vi.fn(),
    deleteStateByWorktreeId: {},
    fetchHostedReviewForBranch,
    fetchIssue,
    fetchLinearIssue,
    gitConflictOperationByWorktree: {},
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    openModal: vi.fn(),
    openTaskPage: vi.fn(),
    projectGroups: [],
    ptyIdsByTabId: {},
    recordFeatureInteraction: vi.fn(),
    remoteBranchConflictByWorktreeId: {},
    setRemoteBrowserPageHandle: vi.fn(),
    replaceWorkspacePortScans,
    setWorkspacePortScanRefreshing,
    settings,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    tabsByWorktree: {},
    updateWorktreeMeta: vi.fn(),
    workspacePortScan,
    worktreeCardProperties
  })
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState
    })
  }
})

// Expose hover controls to verify compact identity and metadata have one owner.
const openChangeByRoot = new Map<HTMLElement, (open: boolean) => void>()
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    open,
    onOpenChange,
    openDelay
  }: {
    children: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
    openDelay?: number
  }) => (
    <div
      data-hovercard-root=""
      data-open={String(Boolean(open))}
      data-hover-open-delay={openDelay}
      ref={(el) => {
        if (el && onOpenChange) {
          openChangeByRoot.set(el, onOpenChange)
        }
      }}
    >
      {children}
    </div>
  ),
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div data-hover-card-content="">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) =>
    React.isValidElement(children) ? (
      React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        'data-hover-card-trigger': ''
      })
    ) : (
      <>{children}</>
    )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'active'
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: cacheTimerMocks.usePromptCacheCountdownStartedAt
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => [] as DashboardAgentRowData[])
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => <div data-worktree-agents="" />
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

let workspacePortScan: { key: string; result: WorkspacePortScanResult } | null = null

function makeRepo(): Repo {
  return { id: 'repo-1', path: '/repo', displayName: 'orca', badgeColor: '#999999', addedAt: 1 }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/pr-456',
    repoId: 'repo-1',
    path: '/repo/worktrees/pr-456',
    displayName: 'Fix stale GH PR',
    branch: 'feature/local-branch',
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

function makePortScan(worktree: Worktree): { key: string; result: WorkspacePortScanResult } {
  return {
    key: 'repo-1',
    result: {
      platform: 'darwin',
      scannedAt: 1,
      ports: [
        {
          id: '127.0.0.1:58941:1234',
          bindHost: '127.0.0.1',
          connectHost: '127.0.0.1',
          port: 58941,
          pid: 1234,
          processName: 'node',
          protocol: 'http',
          kind: 'workspace',
          owner: {
            worktreeId: worktree.id,
            repoId: worktree.repoId,
            displayName: worktree.displayName,
            path: worktree.path,
            confidence: 'cwd'
          }
        }
      ]
    }
  }
}

function rootContaining(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  if (!el) {
    throw new Error(`No element matched ${selector}`)
  }
  const root = el.closest('[data-hovercard-root]')
  if (!(root instanceof HTMLElement)) {
    throw new Error(`No hover-card root ancestor for ${selector}`)
  }
  return root
}

describe('WorktreeCard compact hover ownership', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    openChangeByRoot.clear()
    worktreeCardProperties = ['status', 'ports']
    settings = { compactWorktreeCards: true }
    cacheTimerMocks.usePromptCacheCountdownStartedAt.mockReturnValue(null)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('uses one full identity anchor for compact title, metadata, and live ports', async () => {
    const worktree = makeWorktree({
      linkedItems: [
        {
          provider: 'github',
          type: 'pr',
          number: 57,
          title: 'Review',
          url: 'https://github.com/acme/orca/pull/57'
        },
        {
          provider: 'linear',
          type: 'issue',
          number: 0,
          identifier: 'ENG-2',
          title: 'Task',
          url: 'https://linear.app/acme/issue/ENG-2/task'
        }
      ]
    })
    workspacePortScan = makePortScan(worktree)
    const { default: WorktreeCard } = await import('./WorktreeCard')

    act(() => {
      root.render(<WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />)
    })

    const titleRoot = rootContaining('[data-worktree-title-inline-rename]')
    const portsRoot = rootContaining('[aria-label="1 live port"]')
    const metadataRoot = rootContaining('[aria-label="Workspace metadata"]')
    expect(titleRoot).toBe(portsRoot)
    expect(titleRoot).toBe(metadataRoot)
    expect(container.querySelectorAll('[data-hovercard-root]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-hover-card-content]')).toHaveLength(1)
    expect(
      container
        .querySelector('[data-worktree-card-hover-trigger]')
        ?.hasAttribute('data-hover-card-trigger')
    ).toBe(true)
    const open = openChangeByRoot.get(titleRoot)
    act(() => {
      open?.(true)
    })
    expect(container.querySelectorAll('[data-open="true"]')).toHaveLength(1)
    act(() => {
      open?.(false)
      open?.(true)
    })
    expect(container.querySelectorAll('[data-open="true"]')).toHaveLength(1)
    expect(titleRoot.textContent).toContain('Reviews · 1')
    expect(titleRoot.textContent).toContain('Issues & tasks · 1')
    expect(titleRoot.textContent).toContain('58941')
  })
})
