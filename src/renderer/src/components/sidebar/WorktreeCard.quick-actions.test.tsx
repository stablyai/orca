import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitConflictOperation,
  GlobalSettings,
  Repo,
  Worktree,
  WorktreeCardProperty
} from '../../../../shared/types'
import type WorktreeCardComponent from './WorktreeCard'
import type * as WorkspaceDeleteQuickAction from './workspace-delete-quick-action'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['status']
let tabsByWorktree: Record<string, { id: string }[]> = {}
let ptyIdsByTabId: Record<string, string[]> = {}
let browserTabsByWorktree: Record<string, { id: string }[]> = {}
let settings: Partial<GlobalSettings> | null = null
let workspaceDeleteModifierPressed = false
let gitConflictOperationByWorktree: Record<string, GitConflictOperation> = {}
let WorktreeCard: typeof WorktreeCardComponent

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      gitConflictOperationByWorktree,
      hostedReviewCache: {},
      issueCache: {},
      openModal,
      remoteBranchConflictByWorktreeId: {},
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      browserTabsByWorktree,
      ptyIdsByTabId,
      tabsByWorktree,
      updateWorktreeMeta,
      worktreeCardProperties
    })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
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

vi.mock('./workspace-delete-quick-action', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceDeleteQuickAction>()
  return {
    ...actual,
    useWorkspaceDeleteModifierPressed: () => workspaceDeleteModifierPressed
  }
})

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
    id: 'repo-1::/repo/worktrees/quick-action',
    repoId: 'repo-1',
    path: '/repo/worktrees/quick-action',
    displayName: 'Quick action',
    branch: 'quick-action',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: true,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function getBranchMetadataLabelTag(markup: string): string {
  const labelTag = markup
    .match(/<span[^>]*>quick-action<\/span>/g)
    ?.find((tag) => tag.includes('text-[11px]'))

  expect(labelTag).toBeDefined()
  return labelTag ?? ''
}

describe('WorktreeCard quick actions', () => {
  beforeAll(async () => {
    WorktreeCard = (await import('./WorktreeCard')).default
  }, 20_000)

  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status']
    tabsByWorktree = {}
    ptyIdsByTabId = {}
    browserTabsByWorktree = {}
    settings = null
    workspaceDeleteModifierPressed = false
    gitConflictOperationByWorktree = {}
  })

  it('marks the unread toggle as a workspace-board-preserving action', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('data-workspace-board-preserve-open=""')
  })

  it('renders repo identity in the detailed metadata row', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('aria-label="Project orca"')
    expect(markup).toContain('>orca</span>')
    expect(markup).toContain('data-worktree-card-meta-row=""')
  })

  it('can render the current workspace with a secondary active surface', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree()}
        repo={makeRepo()}
        isActive
        activeSurfaceVariant="secondary"
      />
    )

    expect(markup).toContain('data-worktree-card-active="secondary"')
    expect(markup).toContain('bg-sidebar-accent/45')
    expect(markup).not.toContain('bg-black/[0.08]')
  })

  it('renders folder kind and directory in the detailed metadata row', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'Docs folder', branch: '' })}
        repo={{ ...makeRepo(), kind: 'folder' }}
        isActive={false}
      />
    )

    expect(markup).toContain('Docs folder')
    expect(markup).toContain('>Folder</span>')
    expect(markup).toContain('>quick-action</span>')
    expect(markup).toContain('data-worktree-card-meta-row=""')
  })

  it('renders synthetic folder workspace directory in the detailed metadata row', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          id: 'folder:folder-1',
          displayName: 'Docs folder',
          branch: '',
          path: '/repo/worktrees/quick-action'
        })}
        repo={undefined}
        isActive={false}
      />
    )

    expect(markup).toContain('Docs folder')
    expect(markup).toContain('>Folder</span>')
    expect(markup).toContain('>quick-action</span>')
    expect(markup).toContain('data-worktree-card-meta-row=""')
  })

  it('does not render a pending first-agent rename title badge', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ pendingFirstAgentMessageRename: true })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toMatch(/Will be renamed from first agent message|rename pending/)
    expect(markup).not.toContain(
      'aria-label="This worktree will be renamed from the first agent message"'
    )
    expect(markup).not.toContain('rename pending')
    expect(markup).not.toContain('This worktree will be renamed from the first agent message')
  })

  it('renders the failed first-agent rename title badge', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ firstAgentMessageRenameError: 'model could not name this' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('aria-label="Auto-rename failed: view error"')
    expect(markup).toContain('rename failed')
  })

  it('renders the failed first-agent rename title badge when rename is also pending', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          firstAgentMessageRenameError: 'model could not name this',
          pendingFirstAgentMessageRename: true
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('aria-label="Auto-rename failed: view error"')
    expect(markup).toContain('rename failed')
    expect(markup).not.toContain('rename pending')
  })

  it('renders the migrated branch metadata row when branch is enabled', () => {
    worktreeCardProperties = ['branch']

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'quick-action', branch: 'quick-action' })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('quick-action')
    const branchLabelTag = getBranchMetadataLabelTag(markup)
    expect(branchLabelTag).toContain('truncate')
    expect(branchLabelTag).toContain('text-[11px]')
    expect(branchLabelTag).toContain('text-muted-foreground')
    expect(branchLabelTag).toContain('leading-none')
    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('tabindex="0"')
  })

  it('renders detached HEAD identity in detailed card metadata', () => {
    worktreeCardProperties = []

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'orca', branch: '' })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('orca')
    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('Detached HEAD @ abc123')
    expect(markup).toContain('Detached HEAD at abc123. You are viewing a commit, not a branch.')
    expect(markup).toContain('tabindex="0"')
  })

  it('omits the repeated branch metadata row when compact cards are enabled', () => {
    worktreeCardProperties = []
    settings = { compactWorktreeCards: true }

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'quick-action', branch: 'quick-action' })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('tabindex="0"')
  })

  it('omits the branch metadata row when the workspace has a custom title', () => {
    worktreeCardProperties = []
    settings = { compactWorktreeCards: true }

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'Custom workspace', branch: 'quick-action' })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('Custom workspace')
    expect(markup).not.toContain('>quick-action<')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expect(markup).not.toContain('text-[11px] text-muted-foreground truncate leading-none')
  })

  it('uses the left status lane and primary badge when compact cards are disabled', () => {
    worktreeCardProperties = ['status']

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          displayName: 'main',
          branch: 'main',
          isMainWorktree: true
        })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('primary')
    expect(markup).not.toContain('aria-label="Primary worktree"')
    expect(markup).toContain('data-worktree-card-meta-row=""')
  })

  it('keeps unread in the status lane and moves primary into the title row when compact cards are enabled', () => {
    worktreeCardProperties = ['status']
    settings = { compactWorktreeCards: true }

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          displayName: 'main',
          branch: 'main',
          isMainWorktree: true
        })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('aria-label="Primary worktree"')
    expect(markup).not.toContain('>primary<')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
  })

  it('hides delete by default for an inactive workspace', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('shows delete as the top-right quick action while Option/Alt is held', () => {
    workspaceDeleteModifierPressed = true

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('aria-label="Delete workspace"')
  })

  it('shows delete as the quick action for folder workspace instances while Option/Alt is held', () => {
    workspaceDeleteModifierPressed = true

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          id: 'repo-1::/repo::workspace:123e4567-e89b-12d3-a456-426614174000',
          path: '/repo',
          isMainWorktree: false
        })}
        repo={{ ...makeRepo(), kind: 'folder' }}
        isActive={false}
      />
    )

    expect(markup).toContain('aria-label="Delete workspace"')
  })

  it('shows delete for a current workspace while Option/Alt is held', () => {
    workspaceDeleteModifierPressed = true
    const worktree = makeWorktree()

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive isCurrentWorktree />
    )

    expect(markup).toContain('aria-label="Delete workspace"')
  })

  it('does not show delete for the main worktree while Option/Alt is held', () => {
    workspaceDeleteModifierPressed = true

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ isMainWorktree: true })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('does not replace sleep with delete for a workspace with live activity', () => {
    const worktree = makeWorktree()
    tabsByWorktree = { [worktree.id]: [{ id: 'tab-1' }] }
    ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('aria-label="Sleep workspace"')
    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('does not show sleep as the top-right quick action for an active workspace', () => {
    const worktree = makeWorktree()
    tabsByWorktree = { [worktree.id]: [{ id: 'tab-1' }] }
    ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive />
    )

    expect(markup).not.toContain('aria-label="Sleep workspace"')
    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('does not show delete when the workspace is current but not selected in the sidebar', () => {
    const worktree = makeWorktree()

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} isCurrentWorktree />
    )

    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('does not show the rebase operation chip on the card', () => {
    const worktree = makeWorktree()
    gitConflictOperationByWorktree = { [worktree.id]: 'rebase' }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('Rebasing')
    expect(markup).toContain('data-worktree-card-meta-row=""')
  })

  it('keeps non-rebase operation chips on the card', () => {
    const worktree = makeWorktree()
    gitConflictOperationByWorktree = { [worktree.id]: 'merge' }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('Merging')
    expect(markup).toContain('data-worktree-card-meta-row=""')
  })
})
