/**
 * @vitest-environment happy-dom
 *
 * Why render the real menu instead of only the mode predicate: the predicate
 * being right is not the same as the rows reaching the dropdown, and the rows
 * are what the user acts on.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { getConnectionId } from '@/lib/connection-context'
import WorktreeContextMenu from './WorktreeContextMenu'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const stateMock = vi.hoisted(() => vi.fn())

function makeWorktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'repo::feature',
    repoId: 'repo',
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: '/path/to/feature',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

const mainWorktreeRow = makeWorktree({
  id: 'repo::main',
  path: '/path/to/main',
  branch: 'refs/heads/main',
  isMainWorktree: true
})

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children?: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button
      type="button"
      data-testid="dropdown-menu-item"
      data-disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuLabel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSub: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('lucide-react', async () =>
  (await import('../tab-bar/lucide-icon-stub-fixture')).stubEveryIcon()
)

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

const defaultStoreState = {
  updateWorktreeMeta: vi.fn(),
  setWorktreesPinnedAndReveal: vi.fn(),
  workspaceStatuses: [],
  openModal: vi.fn(),
  closeModal: vi.fn(),
  projectGroups: [],
  createProjectGroup: vi.fn(),
  moveProjectToGroup: vi.fn(),
  deleteStateByWorktreeId: {},
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  updateWorktreeLineage: vi.fn(),
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  browserTabsByWorktree: {},
  worktreesByRepo: {},
  repos: []
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof defaultStoreState) => unknown) => selector(defaultStoreState),
    { getState: () => defaultStoreState }
  )
}))

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [mainWorktreeRow],
  useRepoById: (repoId?: string) =>
    repoId ? { id: repoId, displayName: repoId, connectionId: null } : undefined,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => new Map()
}))

vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: () => null,
  formatShortcutLabel: () => '',
  formatOptionalShortcutLabel: () => null
}))

vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))
vi.mock('./WorktreeDeveloperMenu', () => ({ WorktreeDeveloperMenu: () => null }))
vi.mock('./WorktreeOpenInMenu', () => ({ WorktreeOpenInSubMenu: () => null }))
vi.mock('./WorkspaceSleepMenuItems', () => ({ WorkspaceSleepMenuItems: () => null }))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderAndOpen(worktree: Worktree): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <WorktreeContextMenu worktree={worktree}>
        <div>Card Content</div>
      </WorktreeContextMenu>
    )
  })
  mounted.push({ container, root })
  const scope = container.querySelector('[data-worktree-context-menu-scope]')
  act(() => {
    scope?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
  return container
}

function itemLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="dropdown-menu-item"]')).map(
    (element) => element.textContent ?? ''
  )
}

describe('WorktreeContextMenu merge review rows', () => {
  beforeEach(() => {
    stateMock.mockReset()
    stateMock.mockResolvedValue({ phase: 'idle', syncSupported: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { git: { worktreeMergeReviewState: stateMock } }
    })
  })

  afterEach(() => {
    for (const { root, container } of mounted) {
      act(() => {
        root.unmount()
      })
      container.remove()
    }
    mounted.length = 0
  })

  it('offers the merge on a task worktree and probes the repository', async () => {
    const container = renderAndOpen(makeWorktree({}))
    await act(async () => {})

    expect(itemLabels(container)).toContain('Merge into Main Worktree')
    expect(stateMock).toHaveBeenCalledWith({ worktreePath: '/path/to/feature' })
  })

  it('sends the worktree connection id with the state probe', async () => {
    vi.mocked(getConnectionId).mockReturnValueOnce('conn-1')

    renderAndOpen(makeWorktree({}))
    await act(async () => {})

    expect(stateMock).toHaveBeenCalledWith({
      worktreePath: '/path/to/feature',
      connectionId: 'conn-1'
    })
  })

  it('offers accept/reject on both cards once a review is pending', async () => {
    stateMock.mockResolvedValue({ phase: 'pending', branch: 'feature', conflicts: [] })

    const taskContainer = renderAndOpen(makeWorktree({}))
    await act(async () => {})
    expect(itemLabels(taskContainer)).toContain('Accept Merge')
    expect(itemLabels(taskContainer)).toContain('Undo Merge')
    expect(itemLabels(taskContainer)).not.toContain('Merge into Main Worktree')

    // The main checkout can never start a review, but it must be able to end one.
    const mainContainer = renderAndOpen(mainWorktreeRow)
    await act(async () => {})
    expect(itemLabels(mainContainer)).toContain('Accept Merge')
  })

  it('hides sync where the host cannot snapshot', async () => {
    stateMock.mockResolvedValue({ phase: 'idle', syncSupported: false })

    const container = renderAndOpen(makeWorktree({}))
    await act(async () => {})

    expect(itemLabels(container)).not.toContain('Merge into Main Worktree')
  })

  it('hides the rows on the main checkout while nothing is pending', async () => {
    const container = renderAndOpen(mainWorktreeRow)
    await act(async () => {})

    expect(itemLabels(container)).not.toContain('Merge into Main Worktree')
    expect(itemLabels(container)).not.toContain('Accept Merge')
  })
})
