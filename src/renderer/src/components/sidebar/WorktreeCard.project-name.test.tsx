// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'

let worktreeCardProperties: WorktreeCardProperty[] = ['status']
let experimentalNewWorktreeCardStyle = true
let compactWorktreeCards = false
let root: Root | null = null
let container: HTMLDivElement | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
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
      settings: { experimentalNewWorktreeCardStyle, compactWorktreeCards },
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      updateWorktreeMeta: vi.fn(),
      workspacePortScan: null,
      worktreeCardProperties
    })
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope'
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'active'
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

function makeFolderRepo(): Repo {
  // Why: a folder workspace has a repo but suppresses the repo icon chip, so the
  // inline project label must not render even though showProjectName is set.
  return { ...makeRepo(), kind: 'folder' }
}

// Why: reproduces a project's primary worktree with no session — the title
// falls back to the branch, so `main`/`master` alone can't tell projects apart.
function makePrimaryWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo',
    repoId: 'repo-1',
    path: '/repo',
    displayName: 'main',
    branch: 'main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: true,
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

function projectNameEl(): HTMLElement | null {
  return container?.querySelector('[data-worktree-card-project-name]') ?? null
}

describe('WorktreeCard project name (board)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status']
    experimentalNewWorktreeCardStyle = true
    compactWorktreeCards = false
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('renders the project name as text when showProjectName is set (board card)', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')

    act(() => {
      root?.render(
        <WorktreeCard
          worktree={makePrimaryWorktree()}
          repo={makeRepo()}
          isActive={false}
          showProjectName
        />
      )
    })

    expect(projectNameEl()?.textContent).toBe('orca')
  })

  it('omits the project name text without showProjectName (sidebar card)', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')

    act(() => {
      root?.render(
        <WorktreeCard worktree={makePrimaryWorktree()} repo={makeRepo()} isActive={false} />
      )
    })

    // Why: the sidebar keeps the icon-only chip (name lives in its tooltip).
    expect(projectNameEl()).toBeNull()
  })

  it('does not show the project name for a folder workspace', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')

    act(() => {
      root?.render(
        <WorktreeCard
          worktree={makePrimaryWorktree()}
          repo={makeFolderRepo()}
          isActive={false}
          showProjectName
        />
      )
    })

    // Why: folder workspaces suppress the repo icon chip, so the inline project
    // label is gated off with it even though showProjectName is set.
    expect(projectNameEl()).toBeNull()
  })
})
