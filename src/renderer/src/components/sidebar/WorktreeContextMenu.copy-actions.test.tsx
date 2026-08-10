// @vitest-environment happy-dom
/**
 * Regression guard for #6167 (assertions unchanged from the original repro): the worktree
 * row context menu must group Copy Path / Copy branch name / Copy PR URL, each with its own
 * clipboard write. Behavioral coverage lives in WorktreeContextMenu.copy-targets.test.tsx.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#fff',
  addedAt: 0,
  connectionId: null,
  gitRemoteIdentity: {
    provider: 'github',
    host: 'github.com',
    owner: 'stablyai',
    name: 'orca'
  }
} as unknown as Repo

vi.mock('@/store', () => {
  const state = {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    deleteStateByWorktreeId: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    workspaceStatuses: [],
    projectGroups: [],
    settings: null,
    updateWorktreeMeta: vi.fn(),
    setWorktreesPinnedAndReveal: vi.fn(),
    openModal: vi.fn(),
    createProjectGroup: vi.fn(),
    moveProjectToGroup: vi.fn(),
    deleteFolderWorkspace: vi.fn(),
    setActiveWorktree: vi.fn()
  }
  return {
    useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [],
  useRepoById: () => REPO,
  useRepoMap: () => new Map([[REPO.id, REPO]]),
  useWorktreeMap: () => new Map()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

// Radix portals need real layout; passthrough keeps the test on menu contents.
vi.mock('@/components/ui/dropdown-menu', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough,
    DropdownMenuLabel: passthrough,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuSubTrigger: passthrough,
    DropdownMenuTrigger: passthrough
  }
})

vi.mock('./WorktreeOpenInMenu', () => ({ WorktreeOpenInSubMenu: () => null }))
vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('./delete-worktree-flow', () => ({
  runWorktreeBatchDelete: vi.fn(),
  runWorktreeDelete: vi.fn()
}))
vi.mock('./sleep-worktree-flow', () => ({ runSleepWorktrees: vi.fn() }))

const WorktreeContextMenu = (await import('./WorktreeContextMenu')).default

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/repo/wt',
    repoId: 'repo-1',
    path: '/repo/wt',
    displayName: 'wt',
    branch: 'feature/copy-menu',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: 6167,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  } as Worktree
}

function openContextMenu(): string {
  const { container } = render(
    <WorktreeContextMenu worktree={makeWorktree()}>
      <div data-testid="card">card</div>
    </WorktreeContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId('card'), { altKey: false })
  return container.textContent ?? ''
}

describe('#6167 worktree context menu Copy submenu', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('offers Copy branch name for a worktree on a branch', () => {
    const text = openContextMenu()

    expect(text).toContain('Copy Path')
    expect(text).toContain('Copy branch name')
  })

  it('offers Copy PR URL for a worktree with a linked pull request', () => {
    const text = openContextMenu()

    expect(text).toContain('Copy PR URL')
  })

  // Exhaustive absence evidence: the menu source has exactly one clipboard write.
  it('wires a clipboard write per requested Copy action', () => {
    const source = readFileSync(join(__dirname, 'WorktreeContextMenu.tsx'), 'utf8')
    const clipboardWrites = source.match(/writeClipboardText/g) ?? []

    expect(clipboardWrites.length).toBeGreaterThanOrEqual(3)
  })
})
