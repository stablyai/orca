// @vitest-environment happy-dom
/**
 * Behavioral coverage for the #6167 Copy group: provider-neutral labels, what each item
 * writes to the clipboard, disabled states, and multi-select gating.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

const REPO = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#fff',
  addedAt: 0,
  connectionId: null
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

// Radix portals need real layout; plain buttons keep onSelect/disabled observable.
vi.mock('@/components/ui/dropdown-menu', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect
    }: {
      children?: ReactNode
      disabled?: boolean
      onSelect?: () => void
    }) => (
      <button type="button" role="menuitem" disabled={disabled} onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const WorktreeContextMenu = (await import('./WorktreeContextMenu')).default
const { toast } = await import('sonner')

const writeClipboardText = vi.fn<(text: string) => Promise<void>>()
let fakeNow = 1_000

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/wt',
    repoId: 'repo-1',
    path: '/repo/wt',
    displayName: 'wt',
    branch: 'feature/copy-menu',
    head: 'abc1234',
    linkedPR: null,
    ...overrides
  } as Worktree
}

function openMenu(props: {
  worktree?: Worktree
  branchName?: string | null
  review?: WorktreeCardPrDisplay | null
  selectedWorktrees?: readonly Worktree[]
}): void {
  render(
    <WorktreeContextMenu
      worktree={props.worktree ?? makeWorktree()}
      branchName={props.branchName}
      review={props.review}
      selectedWorktrees={props.selectedWorktrees}
    >
      <div data-testid="card">card</div>
    </WorktreeContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId('card'), { altKey: false })
  // The wrapper swallows clicks that land inside the ctrl-click suppression window.
  fakeNow += 1_000
}

function menuItem(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole('menuitem', { name }) as HTMLButtonElement
}

beforeEach(() => {
  fakeNow = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
  writeClipboardText.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText } }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('worktree context menu Copy group', () => {
  it('copies the worktree path', () => {
    openMenu({})

    fireEvent.click(menuItem('Copy Path'))

    expect(writeClipboardText).toHaveBeenCalledWith('/repo/wt')
  })

  it('copies a Windows path verbatim', () => {
    openMenu({ worktree: makeWorktree({ path: 'C:\\repos\\orca\\wt' }) })

    fireEvent.click(menuItem('Copy Path'))

    expect(writeClipboardText).toHaveBeenCalledWith('C:\\repos\\orca\\wt')
  })

  it('copies the branch name the owning card resolved', () => {
    openMenu({ branchName: 'feature/from-card' })

    fireEvent.click(menuItem(/Copy branch name/))

    expect(writeClipboardText).toHaveBeenCalledWith('feature/from-card')
  })

  it('copies the review URL for a GitHub pull request', () => {
    openMenu({
      worktree: makeWorktree({ linkedPR: 6167 }),
      review: {
        provider: 'github',
        number: 6167,
        title: 'PR',
        url: 'https://github.com/stablyai/orca/pull/6167'
      }
    })

    fireEvent.click(menuItem(/Copy PR URL/))

    expect(writeClipboardText).toHaveBeenCalledWith('https://github.com/stablyai/orca/pull/6167')
  })

  it('labels a GitLab merge request MR and never offers PR URL', () => {
    openMenu({
      worktree: makeWorktree({ linkedGitLabMR: 12 } as Partial<Worktree>),
      review: {
        provider: 'gitlab',
        number: 12,
        title: 'MR',
        url: 'https://gitlab.example.com/group/proj/-/merge_requests/12'
      }
    })

    fireEvent.click(menuItem(/Copy MR URL/))

    expect(writeClipboardText).toHaveBeenCalledWith(
      'https://gitlab.example.com/group/proj/-/merge_requests/12'
    )
    expect(screen.queryByRole('menuitem', { name: /Copy PR URL/ })).toBeNull()
  })

  it('copies a branch-lookup review URL the card resolved without linked metadata', () => {
    openMenu({
      worktree: makeWorktree({ linkedPR: null }),
      review: {
        provider: 'github',
        number: 42,
        title: 'External PR',
        url: 'https://github.com/stablyai/orca/pull/42'
      }
    })

    fireEvent.click(menuItem(/Copy PR URL/))

    expect(writeClipboardText).toHaveBeenCalledWith('https://github.com/stablyai/orca/pull/42')
  })

  it('disables the branch item on a detached HEAD instead of copying a commit', () => {
    openMenu({ worktree: makeWorktree({ branch: '', head: 'deadbee1234' }), branchName: '' })

    const item = menuItem(/Copy branch name/)
    expect(item.disabled).toBe(true)
    fireEvent.click(item)

    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('disables the review item until a review URL resolves', () => {
    openMenu({ worktree: makeWorktree({ linkedPR: 6167 }), review: undefined })

    const item = menuItem(/Copy PR URL/)
    expect(item.disabled).toBe(true)
    fireEvent.click(item)

    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('reports a clipboard failure instead of leaving an unhandled rejection', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    openMenu({})

    fireEvent.click(menuItem('Copy Path'))
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())

    expect(toast.success).not.toHaveBeenCalled()
  })

  it('hides the Copy group for a multi-worktree selection', () => {
    const second = makeWorktree({ id: 'repo-1::/repo/wt2', path: '/repo/wt2' })
    openMenu({ selectedWorktrees: [makeWorktree(), second] })

    expect(screen.queryByRole('menuitem', { name: 'Copy Path' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Copy branch name/ })).toBeNull()
  })
})
