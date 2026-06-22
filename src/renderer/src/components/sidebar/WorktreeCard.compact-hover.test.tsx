import { renderToStaticMarkup } from 'react-dom/server'
import React, { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { GlobalSettings, Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const openTaskPage = vi.fn()
const updateWorktreeMeta = vi.fn()
const recordFeatureInteraction = vi.fn()
const setWorkspacePortScan = vi.fn()
const setWorkspacePortScanRefreshing = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'ports']
let hostedReviewCache: Record<string, unknown> = {}
let workspacePortScan: { key: string; result: WorkspacePortScanResult } | null = null
let settings: Partial<GlobalSettings> | null = { compactWorktreeCards: true }

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      browserTabsByWorktree: {},
      createBrowserTab: vi.fn(),
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      fetchLinearIssue,
      gitConflictOperationByWorktree: {},
      hostedReviewCache,
      issueCache: {},
      linearIssueCache: {},
      openModal,
      openTaskPage,
      ptyIdsByTabId: {},
      recordFeatureInteraction,
      remoteBranchConflictByWorktreeId: {},
      setRemoteBrowserPageHandle: vi.fn(),
      setWorkspacePortScan,
      setWorkspacePortScanRefreshing,
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      tabsByWorktree: {},
      updateWorktreeMeta,
      workspacePortScan,
      worktreeCardProperties
    })
}))

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children, openDelay }: { children: ReactNode; openDelay?: number }) => (
    <div data-hover-open-delay={openDelay}>{children}</div>
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
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: ({ className }: { className?: string }) => (
    <div className={className} data-worktree-agents="" />
  )
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

function makeHostedReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 456,
    title: 'Fix stale GH PR',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/456',
    status: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function expectParentBodyIsHoverTrigger(markup: string): void {
  const surfaceTag = markup.match(/<div[^>]*data-worktree-card-surface="true"[^>]*>/)?.[0]
  const triggerTag = markup.match(/<div[^>]*data-worktree-card-hover-trigger=""[^>]*>/)?.[0]

  expect(surfaceTag).toBeDefined()
  expect(surfaceTag).not.toContain('data-hover-card-trigger=""')
  expect(surfaceTag).not.toContain('group/worktree-card')
  expect(triggerTag).toBeDefined()
  expect(triggerTag).toContain('data-hover-card-trigger=""')
  expect(triggerTag).toContain('group/worktree-card')
}

describe('WorktreeCard compact hover details', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status', 'ports']
    hostedReviewCache = {}
    workspacePortScan = null
    settings = { compactWorktreeCards: true }
  })

  it('shows PR and live port details from the compact worktree card hover', async () => {
    settings = { compactWorktreeCards: true, experimentalNewWorktreeCardStyle: true }
    const worktree = makeWorktree({ linkedPR: 456 })
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview(),
        fetchedAt: Date.now()
      }
    }
    workspacePortScan = {
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
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('data-worktree-title-inline-rename=""')
    expectParentBodyIsHoverTrigger(markup)
    expect(markup).toContain('data-hover-open-delay="100"')
    expect(markup).toContain('PR #456')
    expect(markup).toContain('Fix stale GH PR')
    expect(markup).toContain('Live Ports')
    expect(markup).toContain('58941')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('aria-label="1 live port"')
  }, 30_000)

  it('shows hidden task, notes, and port details from the compact worktree card hover', async () => {
    settings = { compactWorktreeCards: true, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status']
    const worktree = makeWorktree({
      linkedIssue: 123,
      linkedLinearIssue: 'ENG-123',
      linkedPR: 456,
      comment: 'Reviewer handoff note'
    })
    workspacePortScan = {
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
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('data-hover-open-delay="100"')
    expectParentBodyIsHoverTrigger(markup)
    expect(markup).toContain('Issue #123')
    expect(markup).toContain('Linear ENG-123')
    expect(markup).toContain('Reviewer handoff note')
    expect(markup).toContain('Live Ports')
    expect(markup).toContain('58941')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
  }, 30_000)

  it('shows selected task and note metadata on the compact card title row', async () => {
    settings = { compactWorktreeCards: true, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'issue', 'linear-issue', 'comment']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          linkedIssue: 123,
          linkedLinearIssue: 'ENG-123',
          comment: 'Reviewer handoff note'
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('Linked issue #123')
    expect(markup).toContain('Linked Linear ENG-123')
    expect(markup).toContain('Workspace notes')
  }, 30_000)

  it('keeps selected task and note metadata above the compact branch row', async () => {
    settings = { compactWorktreeCards: true, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'branch', 'issue', 'linear-issue', 'comment']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          linkedIssue: 123,
          linkedLinearIssue: 'ENG-123',
          comment: 'Reviewer handoff note'
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )
    const issueIndex = markup.indexOf('Linked issue #123')
    const branchRowIndex = markup.indexOf('data-worktree-card-meta-row=""')

    expect(issueIndex).toBeGreaterThanOrEqual(0)
    expect(branchRowIndex).toBeGreaterThanOrEqual(0)
    expect(issueIndex).toBeLessThan(branchRowIndex)
    expect(markup).toContain('Linked Linear ENG-123')
    expect(markup).toContain('Workspace notes')
    expect(markup).toContain('feature/local-branch')
  }, 30_000)

  it('keeps branch identity visible on detailed cards by default', async () => {
    settings = { compactWorktreeCards: false }
    worktreeCardProperties = ['status', 'issue', 'linear-issue', 'comment', 'ports']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'Human title' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('data-hover-open-delay="100"')
    expect(markup).toContain('feature/local-branch')
    expect(markup).toContain('Human title')
  })

  it('uses one whole-card hover even when detailed metadata icons are visible when new card style is on', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'issue', 'linear-issue', 'comment', 'ports']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          linkedIssue: 123,
          linkedLinearIssue: 'ENG-123',
          linkedPR: 456,
          comment: 'Reviewer handoff note'
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('Workspace metadata')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expectParentBodyIsHoverTrigger(markup)
    expect(markup.match(/data-hover-open-delay="100"/g)).toHaveLength(1)
    expect(markup).toContain('Reviewer handoff note')
  })

  it('keeps long workspace and branch identity in whole-card hover details when the branch row is hidden', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'comment']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          branch: 'bug-hold-to-talk-speech-to-text-option-no-longer-works',
          displayName: '[Bug]: Hold-to-talk speech-to-text option no longer works',
          comment: 'Reviewer handoff note'
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expectParentBodyIsHoverTrigger(markup)
    expect(markup).toContain('[Bug]: Hold-to-talk speech-to-text option no longer works')
    expect(markup).toContain('bug-hold-to-talk-speech-to-text-option-no-longer-works')
    expect(markup).toContain('Reviewer handoff note')
  })

  it('repeats a long workspace title inside the whole-card hover when branch is already visible', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'branch', 'comment']
    const longTitle =
      'Investigate why the worktree hover card title disappears behind single-line truncation'
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: longTitle, comment: 'Reviewer handoff note' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expectParentBodyIsHoverTrigger(markup)
    expect(markup.match(new RegExp(longTitle, 'g'))).toHaveLength(2)
    expect(markup).toContain('feature/local-branch')
    expect(markup).toContain('Reviewer handoff note')
  })

  it('uses whole-card hover for identity-only new card worktrees with branch row visible', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'branch']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'Readable identity only' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('data-worktree-card-meta-row=""')
    expectParentBodyIsHoverTrigger(markup)
    expect(markup.match(/data-hover-open-delay="100"/g)).toHaveLength(1)
    expect(markup.match(/Readable identity only/g)).toHaveLength(2)
    expect(markup).toContain('feature/local-branch')
    expect(markup).not.toContain('Workspace metadata')
    expect(markup).not.toContain('Live Ports')
  })

  it('does not duplicate workspace identity when trimmed title equals branch', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'branch']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: '  feature/local-branch  ' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expectParentBodyIsHoverTrigger(markup)
    expect(markup.match(/feature\/local-branch/g)).toHaveLength(3)
  })

  it('keeps detailed metadata hover scoped to metadata icons by default', async () => {
    settings = { compactWorktreeCards: false }
    worktreeCardProperties = ['status', 'issue', 'linear-issue', 'comment', 'ports']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          linkedIssue: 123,
          linkedLinearIssue: 'ENG-123',
          linkedPR: 456,
          comment: 'Reviewer handoff note'
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('data-worktree-card-meta-row=""')
    const surfaceTag = markup.match(/<div[^>]*data-worktree-card-surface="true"[^>]*>/)?.[0]
    expect(surfaceTag).toBeDefined()
    expect(surfaceTag).not.toContain('data-hover-card-trigger=""')
    expect(markup.match(/data-hover-open-delay="250"/g)).toHaveLength(1)
    expect(markup).toContain('Reviewer handoff note')
  })

  it('keeps child card markup inside the parent card by default', async () => {
    settings = { compactWorktreeCards: false }
    worktreeCardProperties = ['status', 'comment']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ comment: 'Parent note' })}
        repo={makeRepo()}
        isActive={false}
        lineageChildren={<div data-lineage-child-card="">Child card</div>}
      />
    )
    const childIndex = markup.indexOf('data-lineage-child-card=""')

    const surfaceTag = markup.match(/<div[^>]*data-worktree-card-surface="true"[^>]*>/)?.[0]
    expect(surfaceTag).toBeDefined()
    expect(surfaceTag).not.toContain('data-hover-card-trigger=""')
    expect(markup).not.toContain('data-worktree-lineage-children=""')
    expect(childIndex).toBeGreaterThanOrEqual(0)
  })

  it('suppresses inline agent rows in compact cards by default', async () => {
    settings = { compactWorktreeCards: true }
    worktreeCardProperties = ['status', 'inline-agents']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('data-worktree-agents')
  })

  it('keeps child card markup outside the parent hover trigger when new card style is on', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'comment']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ comment: 'Parent note' })}
        repo={makeRepo()}
        isActive={false}
        lineageChildren={<div data-lineage-child-card="">Child card</div>}
      />
    )
    const surfaceIndex = markup.indexOf('data-worktree-card-surface="true"')
    const triggerIndex = markup.indexOf('data-worktree-card-hover-trigger=""')
    const hoverContentIndex = markup.indexOf('data-hover-card-content=""')
    const childIndex = markup.indexOf('data-lineage-child-card=""')

    expectParentBodyIsHoverTrigger(markup)
    expect(markup).toContain('data-worktree-lineage-children=""')
    expect(markup).toContain('group/worktree-card')
    expect(markup).not.toContain('group relative flex cursor-pointer')
    expect(markup).not.toContain('group/worktree-card relative flex cursor-pointer')
    expect(surfaceIndex).toBeGreaterThanOrEqual(0)
    expect(triggerIndex).toBeGreaterThan(surfaceIndex)
    expect(hoverContentIndex).toBeGreaterThanOrEqual(0)
    expect(childIndex).toBeGreaterThan(hoverContentIndex)
  })

  it('uses a centered parent row and raised title size when no meta row is visible', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} hideRepoBadge />
    )

    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('data-worktree-card-parent-content=""')
    expect(markup).toContain('items-center')
    expect(markup).toContain('w-5 items-center')
    expect(markup).toContain('text-[13px] leading-5')
  })

  it('shows the branch row for migrated Default cards with branch enabled', async () => {
    settings = { compactWorktreeCards: false }
    worktreeCardProperties = ['status', 'branch']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'Human title' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('feature/local-branch')
  })

  it('keeps compact card branch hidden in the row but available from title hover by default', async () => {
    settings = { compactWorktreeCards: true }
    worktreeCardProperties = ['status', 'branch']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'Human title' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('data-hover-open-delay="100"')
    expect(markup).toContain('feature/local-branch')
  })

  it('shows the branch row for compact cards when branch is enabled and new card style is on', async () => {
    settings = { compactWorktreeCards: true, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'branch']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'Human title' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('feature/local-branch')
  })
})
