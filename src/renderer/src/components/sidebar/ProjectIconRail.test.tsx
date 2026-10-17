// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { computeProjectRailSummary, ProjectIconRail } from './ProjectIconRail'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeStatus } from '@/lib/worktree-status'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  setActiveWorktree: vi.fn(),
  setSidebarOpen: vi.fn(),
  setSidebarCollapseMode: vi.fn(),
  openSettingsPage: vi.fn(),
  allWorktrees: [] as Worktree[],
  statuses: new Map<string, WorktreeStatus>()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => mocks.allWorktrees
}))

vi.mock('./use-worktree-activity-statuses', () => ({
  useWorktreeActivityStatuses: () => mocks.statuses
}))

describe('computeProjectRailSummary', () => {
  it('identifies running status when any worktree is working, monitoring, or needs permission', () => {
    const worktree1: Partial<Worktree> = { id: 'wt-1', isUnread: false }
    const worktree2: Partial<Worktree> = { id: 'wt-2', isUnread: true }
    const statuses = new Map<string, WorktreeStatus>([
      ['wt-1', 'working'],
      ['wt-2', 'active']
    ])

    const summary = computeProjectRailSummary([worktree1, worktree2] as Worktree[], statuses)
    expect(summary.status).toBe('running')
    expect(summary.runningCount).toBe(1)
    expect(summary.unreadCount).toBe(1)
    expect(summary.totalCount).toBe(2)
  })

  it('identifies completed status with unread bell when not running and has unread/done', () => {
    const worktree1: Partial<Worktree> = { id: 'wt-1', isUnread: true }
    const worktree2: Partial<Worktree> = { id: 'wt-2', isUnread: false }
    const statuses = new Map<string, WorktreeStatus>([
      ['wt-1', 'active'],
      ['wt-2', 'done']
    ])

    const summary = computeProjectRailSummary([worktree1, worktree2] as Worktree[], statuses)
    expect(summary.status).toBe('completed')
    expect(summary.runningCount).toBe(0)
    expect(summary.unreadCount).toBe(2)
  })

  it('identifies idle status when no worktree is working or unread', () => {
    const worktree1: Partial<Worktree> = { id: 'wt-1', isUnread: false }
    const statuses = new Map<string, WorktreeStatus>([['wt-1', 'active']])

    const summary = computeProjectRailSummary([worktree1] as Worktree[], statuses)
    expect(summary.status).toBe('idle')
    expect(summary.runningCount).toBe(0)
    expect(summary.unreadCount).toBe(0)
  })
})

describe('ProjectIconRail UI', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  const repos: Repo[] = [
    {
      id: 'repo-1',
      displayName: 'xHuman-id',
      badgeColor: '#10b981',
      repoIcon: { type: 'emoji', emoji: '🌐' },
      path: '/path/to/repo1',
      addedAt: Date.now()
    },
    {
      id: 'repo-2',
      displayName: 'Pitch',
      badgeColor: '#f43f5e',
      repoIcon: { type: 'emoji', emoji: '🚀' },
      path: '/path/to/repo2',
      addedAt: Date.now()
    },
    {
      id: 'repo-3',
      displayName: 'Zoo',
      badgeColor: '#eab308',
      repoIcon: { type: 'emoji', emoji: '🐣' },
      path: '/path/to/repo3',
      addedAt: Date.now()
    }
  ]

  const worktrees: Worktree[] = [
    {
      id: 'wt-1',
      repoId: 'repo-1',
      displayName: 'main',
      isUnread: false,
      isMainWorktree: true,
      path: '/path/to/repo1/main',
      head: 'hash1',
      branch: 'main',
      isBare: false,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: Date.now()
    },
    {
      id: 'wt-2',
      repoId: 'repo-2',
      displayName: 'main',
      isUnread: true,
      isMainWorktree: true,
      path: '/path/to/repo2/main',
      head: 'hash2',
      branch: 'main',
      isBare: false,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: Date.now()
    },
    {
      id: 'wt-3',
      repoId: 'repo-3',
      displayName: 'main',
      isUnread: false,
      isMainWorktree: true,
      path: '/path/to/repo3/main',
      head: 'hash3',
      branch: 'main',
      isBare: false,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: Date.now()
    }
  ]

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    mocks.setActiveWorktree.mockClear()
    mocks.setSidebarOpen.mockClear()
    mocks.setSidebarCollapseMode.mockClear()
    mocks.openSettingsPage.mockClear()

    mocks.allWorktrees = worktrees
    mocks.statuses = new Map<string, WorktreeStatus>([
      ['wt-1', 'working'], // repo-1 is running
      ['wt-2', 'active'], // repo-2 is completed (isUnread: true)
      ['wt-3', 'inactive'] // repo-3 is idle
    ])

    mocks.state = {
      repos,
      activeWorktreeId: 'wt-3',
      setActiveWorktree: mocks.setActiveWorktree,
      setSidebarOpen: mocks.setSidebarOpen,
      setSidebarCollapseMode: mocks.setSidebarCollapseMode,
      openSettingsPage: mocks.openSettingsPage
    }
  })

  afterEach(() => {
    if (root && container) {
      act(() => {
        root?.unmount()
      })
      container.remove()
    }
  })

  it('renders all projects with their status badges in the rail', () => {
    act(() => {
      root?.render(
        <TooltipProvider delayDuration={0}>
          <ProjectIconRail />
        </TooltipProvider>
      )
    })

    const rail = container?.querySelector('[data-project-icon-rail="true"]')
    expect(rail).not.toBeNull()

    const item1 = container?.querySelector('[data-project-rail-item="repo-1"]')
    expect(item1).not.toBeNull()
    expect(item1?.getAttribute('data-project-rail-status')).toBe('running')

    const item2 = container?.querySelector('[data-project-rail-item="repo-2"]')
    expect(item2).not.toBeNull()
    expect(item2?.getAttribute('data-project-rail-status')).toBe('completed')

    const item3 = container?.querySelector('[data-project-rail-item="repo-3"]')
    expect(item3).not.toBeNull()
    expect(item3?.getAttribute('data-project-rail-status')).toBe('idle')
  })

  it('expands sidebar when the top expand button is clicked', () => {
    act(() => {
      root?.render(
        <TooltipProvider delayDuration={0}>
          <ProjectIconRail />
        </TooltipProvider>
      )
    })

    const expandBtn = container?.querySelector(
      'button[aria-label="Expand sidebar"]'
    ) as HTMLButtonElement | null
    expect(expandBtn).not.toBeNull()

    act(() => {
      expandBtn?.click()
    })

    expect(mocks.setSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('sets collapse mode to hidden when the hide completely button is clicked', () => {
    act(() => {
      root?.render(
        <TooltipProvider delayDuration={0}>
          <ProjectIconRail />
        </TooltipProvider>
      )
    })

    const hideBtn = container?.querySelector(
      'button[aria-label="Hide sidebar completely"]'
    ) as HTMLButtonElement | null
    expect(hideBtn).not.toBeNull()

    act(() => {
      hideBtn?.click()
    })

    expect(mocks.setSidebarCollapseMode).toHaveBeenCalledWith('hidden')
  })

  it('activates target worktree when clicking a non-active project', () => {
    act(() => {
      root?.render(
        <TooltipProvider delayDuration={0}>
          <ProjectIconRail />
        </TooltipProvider>
      )
    })

    const item1 = container?.querySelector(
      '[data-project-rail-item="repo-1"]'
    ) as HTMLButtonElement | null
    act(() => {
      item1?.click()
    })

    expect(mocks.setActiveWorktree).toHaveBeenCalledWith('wt-1')
  })
})
