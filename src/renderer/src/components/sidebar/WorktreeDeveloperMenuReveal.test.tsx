// @vitest-environment happy-dom
/** Exercise modifier wiring through the real right-click handler; unit-testing the reveal predicate cannot catch an unconditional submenu. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'

vi.mock('@/store', () => {
  const state = {
    unifiedTabsByWorktree: {},
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

vi.mock('@/store/selectors', () => {
  const emptyWorktrees: never[] = []
  const emptyMap = new Map()
  return {
    getAllWorktreesFromState: () => emptyWorktrees,
    useRepoById: () => null,
    getRepoMapFromState: () => emptyMap,
    getWorktreeMapFromState: () => emptyMap
  }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

// Mock layout-dependent Radix portals so this test isolates the reveal decision.
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
    DropdownMenuTrigger: passthrough,
    DropdownMenuShortcut: passthrough
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
    branch: 'wt',
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
    lastActivityAt: 0
  } as Worktree
}

// Read textContent because passthrough labels are bare text nodes that getByText cannot match.
function openContextMenu(altKey: boolean): string {
  const { container } = render(
    <WorktreeContextMenu worktree={makeWorktree()}>
      <div data-testid="card">card</div>
    </WorktreeContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId('card'), { altKey })
  return container.textContent ?? ''
}

describe('Developer submenu reveal', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('hides the Developer submenu on a plain right-click', () => {
    const text = openContextMenu(false)

    expect(text).toContain('Sleep')
    expect(text).not.toContain('Developer')
    expect(text).not.toContain('Park terminal')
  })

  it('reveals the Developer submenu when Option/Alt is held', () => {
    const text = openContextMenu(true)

    expect(text).toContain('Developer')
    expect(text).toContain('Park terminal')
  })
})
