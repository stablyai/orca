// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import type { GlobalSettings, Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const setWorkspacePortScan = vi.fn()
const setWorkspacePortScanRefreshing = vi.fn()
const cacheTimerMocks = vi.hoisted(() => ({
  usePromptCacheCountdownStartedAt: vi.fn()
}))

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'ports']
let settings: Partial<GlobalSettings> | null = { compactWorktreeCards: true }

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
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
      setWorkspacePortScan,
      setWorkspacePortScanRefreshing,
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      tabsByWorktree: {},
      updateWorktreeMeta: vi.fn(),
      workspacePortScan,
      worktreeCardProperties
    })
}))

// Why: the real Radix HoverCard is controlled by each root's `open`/`onOpenChange`; expose them so the test can
// prove the compact title root and the ports root track independent open-state controllers.
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

vi.mock('./SshDisconnectedDialog', () => ({
  SshDisconnectedDialog: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
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

describe('WorktreeCard compact ports hover independence', () => {
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

  it('does not force the compact title hover open when the live-ports hover opens', async () => {
    const worktree = makeWorktree()
    workspacePortScan = makePortScan(worktree)
    const { default: WorktreeCard } = await import('./WorktreeCard')

    act(() => {
      root.render(<WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />)
    })

    // Compact mode renders two hover roots: the title-wrapper root and the plug/ports root.
    const titleRoot = rootContaining('[data-worktree-title-inline-rename]')
    const portsRoot = rootContaining('[aria-label="1 live port"]')
    expect(titleRoot).not.toBe(portsRoot)
    expect(titleRoot.dataset.open).toBe('false')
    expect(portsRoot.dataset.open).toBe('false')

    // Opening the ports hover must not drag the (separately anchored, wider) title card open — that cross-root
    // force-open was the flicker loop in #9304.
    const openPorts = openChangeByRoot.get(portsRoot)
    expect(openPorts).toBeTypeOf('function')
    act(() => {
      openPorts?.(true)
    })

    expect(portsRoot.dataset.open).toBe('true')
    expect(titleRoot.dataset.open).toBe('false')
  })
})
