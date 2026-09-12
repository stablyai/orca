import { renderToStaticMarkup } from 'react-dom/server'
import React, { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'branch']
let settings: Partial<GlobalSettings> | null = { experimentalNewWorktreeCardStyle: true }
let detectedWorktreesByRepo: Record<string, unknown> = {}
let startupWorktreeRefreshCompleted = false

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: undefined,
      browserTabsByWorktree: {},
      createBrowserTab: vi.fn(),
      deleteStateByWorktreeId: {},
      detectedWorktreesByRepo,
      fetchHostedReviewForBranch: vi.fn(),
      fetchIssue: vi.fn(),
      fetchLinearIssue: vi.fn(),
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
      replaceWorkspacePortScans: vi.fn(),
      setRemoteBrowserPageHandle: vi.fn(),
      setWorkspacePortScanRefreshing: vi.fn(),
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      startupWorktreeRefreshCompleted,
      tabsByWorktree: {},
      updateWorktreeMeta: vi.fn(),
      workspacePortScan: null,
      worktreeCardProperties
    })
}))

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
  usePromptCacheCountdownStartedAt: vi.fn(() => null)
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => [])
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => <div data-worktree-agents="" />
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/main',
    repoId: 'repo-1',
    path: '/repo/worktrees/main',
    displayName: 'main',
    branch: 'main',
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

function makeDetected(authoritative: boolean): unknown {
  return {
    repoId: 'repo-1',
    authoritative,
    source: authoritative ? 'git' : 'metadata-fallback',
    worktrees: []
  }
}

function getInlineRenameTitleText(markup: string): string {
  const match = markup.match(/<span[^>]*data-worktree-title-inline-rename=""[^>]*>([^<]*)</)
  return match?.[1] ?? ''
}

function getCardSurfaceTag(markup: string): string {
  const match = markup.match(/<div[^>]*data-worktree-card-surface="true"[^>]*>/)
  expect(match).not.toBeNull()
  return match?.[0] ?? ''
}

async function renderCard(
  overrides: Partial<Worktree> = {},
  repo: Repo = makeRepo(),
  cardProps: { hostContextLabel?: string } = {}
) {
  const { default: WorktreeCard } = await import('./WorktreeCard')
  return renderToStaticMarkup(
    <WorktreeCard worktree={makeWorktree(overrides)} repo={repo} isActive={false} {...cardProps} />
  )
}

describe('WorktreeCard provisional startup rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status', 'branch']
    settings = { experimentalNewWorktreeCardStyle: true }
    detectedWorktreesByRepo = { 'repo-1': makeDetected(false) }
    startupWorktreeRefreshCompleted = false
  })

  it('holds the auto title and reserves the identity row while the catalog is a fallback', async () => {
    // A synthesized fallback row carries no head either; a detached badge is not its shape.
    const markup = await renderCard({
      displayName: 'hetzner-vps',
      branch: '',
      head: '',
      displayNameMode: 'automatic'
    })

    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('data-worktree-card-title-placeholder=""')
    expect(markup).toContain('data-worktree-card-identity-placeholder=""')
    // The hover popover may still echo the persisted name; the card title must not.
    expect(markup.split('data-hover-card-content')[0]).not.toContain(
      'data-worktree-title-inline-rename='
    )
    expect(markup).toContain('animate-pulse')
    expect(markup).toContain('motion-reduce:animate-none')
    // A reserved identity row keeps the settled card padding instead of the title-only `py-2`.
    expect(getCardSurfaceTag(markup)).toContain('pt-1.25')
    expect(getCardSurfaceTag(markup)).not.toContain('py-2')
  })

  it('skips the identity slot but still holds the title when the branch display is off', async () => {
    worktreeCardProperties = ['status']
    const markup = await renderCard({
      displayName: 'hetzner-vps',
      branch: '',
      head: '',
      displayNameMode: 'automatic'
    })

    expect(markup).not.toContain('data-worktree-card-identity-placeholder=""')
    expect(markup).toContain('data-worktree-card-title-placeholder=""')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
  })

  it('holds the title for legacy rows with an omitted display name mode', async () => {
    // Older-host merge rows can carry no mode at all while still being automatic labels.
    const markup = await renderCard({ displayName: 'hetzner-vps', branch: '', head: '' })

    expect(markup).toContain('data-worktree-card-title-placeholder=""')
  })

  it('renders real identity and title for cached rows that already resolved a branch', async () => {
    // A non-authoritative catalog can coexist with richer cached rows that already carry
    // a branch; those are settled data and must not be masked. #20119
    const markup = await renderCard({
      displayName: 'Live feature',
      branch: 'live-branch',
      head: 'abc123',
      displayNameMode: 'automatic'
    })

    expect(markup).not.toContain('data-worktree-card-title-placeholder=""')
    expect(markup).not.toContain('data-worktree-card-identity-placeholder=""')
    expect(getInlineRenameTitleText(markup)).toContain('Live feature')
    expect(markup).toContain('live-branch')
  })

  it('reserves the identity slot alongside existing host meta', async () => {
    const markup = await renderCard(
      { displayName: 'hetzner-vps', branch: '', head: '', displayNameMode: 'automatic' },
      makeRepo(),
      { hostContextLabel: 'Hetzner VPS' }
    )

    expect(markup).toContain('Hetzner VPS')
    expect(markup).toContain('data-worktree-card-identity-placeholder=""')
  })

  it('keeps an explicit fixed label visible while reserving the identity slot', async () => {
    const markup = await renderCard({
      displayName: 'Fixed label',
      branch: '',
      head: '',
      displayNameMode: 'fixed'
    })

    expect(markup).not.toContain('data-worktree-card-title-placeholder=""')
    expect(getInlineRenameTitleText(markup)).toContain('Fixed label')
    expect(markup).toContain('data-worktree-card-identity-placeholder=""')
  })

  it('renders the settled card once the scan is authoritative', async () => {
    detectedWorktreesByRepo = { 'repo-1': makeDetected(true) }
    const markup = await renderCard({
      displayName: 'main',
      branch: 'main',
      displayNameMode: 'automatic'
    })

    expect(markup).not.toContain('data-worktree-card-identity-placeholder=""')
    expect(markup).not.toContain('data-worktree-card-title-placeholder=""')
    expect(getInlineRenameTitleText(markup)).toContain('main')
    expect(markup).toContain('data-worktree-card-meta-row=""')
  })

  it('settles after startup completes even when the catalog stays non-authoritative', async () => {
    startupWorktreeRefreshCompleted = true
    const markup = await renderCard({
      displayName: 'hetzner-vps',
      branch: '',
      head: '',
      displayNameMode: 'automatic'
    })

    expect(markup).not.toContain('data-worktree-card-identity-placeholder=""')
    expect(markup).not.toContain('data-worktree-card-title-placeholder=""')
    expect(getInlineRenameTitleText(markup)).toContain('hetzner-vps')
  })

  it('leaves the legacy card style untouched', async () => {
    settings = { experimentalNewWorktreeCardStyle: false, compactWorktreeCards: false }
    const markup = await renderCard({
      displayName: 'hetzner-vps',
      branch: '',
      head: '',
      displayNameMode: 'automatic'
    })

    expect(markup).not.toContain('data-worktree-card-identity-placeholder=""')
    expect(markup).not.toContain('data-worktree-card-title-placeholder=""')
    expect(getInlineRenameTitleText(markup)).toContain('hetzner-vps')
  })

  it('keeps a real detached badge instead of an identity placeholder', async () => {
    const markup = await renderCard({
      displayName: 'hetzner-vps',
      branch: '',
      head: 'abc123',
      displayNameMode: 'automatic'
    })

    expect(markup).not.toContain('data-worktree-card-identity-placeholder=""')
    expect(markup).toContain('Detached HEAD')
    expect(markup).toContain('data-worktree-card-title-placeholder=""')
  })

  it('does not reserve an identity row for folder workspaces', async () => {
    const markup = await renderCard(
      {
        id: 'repo-1::/repo/folder',
        path: '/repo/folder',
        displayName: 'Folder',
        branch: '',
        head: '',
        displayNameMode: 'automatic'
      },
      makeRepo({ kind: 'folder' })
    )

    expect(markup).not.toContain('data-worktree-card-identity-placeholder=""')
    expect(markup).not.toContain('data-worktree-card-title-placeholder=""')
  })
})
