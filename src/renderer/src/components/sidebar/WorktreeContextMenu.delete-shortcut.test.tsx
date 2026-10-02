/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'
import type { Worktree } from '../../../../shared/worktree/types'
import WorktreeContextMenu from './WorktreeContextMenu'
import { worktree as worktreeFixture } from './worktree-list-groups-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const shortcutLabelMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: shortcutLabelMock,
  formatShortcutLabel: () => '',
  formatOptionalShortcutLabel: () => null
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: function DropdownMenu(props: { children?: React.ReactNode; open?: boolean }) {
    return <div data-testid="dropdown-menu">{props.children}</div>
  },
  DropdownMenuContent: function DropdownMenuContent(props: { children?: React.ReactNode }) {
    return <div data-testid="dropdown-menu-content">{props.children}</div>
  },
  DropdownMenuItem: function DropdownMenuItem(props: {
    children?: React.ReactNode
    disabled?: boolean
    variant?: string
  }) {
    return (
      <div
        data-testid="dropdown-menu-item"
        data-variant={props.variant}
        data-disabled={props.disabled}
      >
        {props.children}
      </div>
    )
  },
  DropdownMenuSeparator: function DropdownMenuSeparator() {
    return <hr />
  },
  DropdownMenuShortcut: function DropdownMenuShortcut(props: { children?: React.ReactNode }) {
    return <span data-testid="dropdown-menu-shortcut">{props.children}</span>
  },
  DropdownMenuLabel: function DropdownMenuLabel(props: { children?: React.ReactNode }) {
    return <div>{props.children}</div>
  },
  DropdownMenuSub: function DropdownMenuSub(props: { children?: React.ReactNode }) {
    return <div>{props.children}</div>
  },
  DropdownMenuSubContent: function DropdownMenuSubContent(props: { children?: React.ReactNode }) {
    return <div>{props.children}</div>
  },
  DropdownMenuSubTrigger: function DropdownMenuSubTrigger(props: { children?: React.ReactNode }) {
    return <div>{props.children}</div>
  },
  DropdownMenuTrigger: function DropdownMenuTrigger(props: { children?: React.ReactNode }) {
    return <div>{props.children}</div>
  },
  DropdownMenuRadioGroup: function DropdownMenuRadioGroup(props: { children?: React.ReactNode }) {
    return <div>{props.children}</div>
  },
  DropdownMenuRadioItem: function DropdownMenuRadioItem(props: { children?: React.ReactNode }) {
    return <div>{props.children}</div>
  }
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

const activeWorkspaceStub: {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: string | null
  getKnownWorktreeById: (id: string, hostId?: string) => Worktree | undefined
} = {
  activeWorktreeId: null,
  activeWorkspaceExecutionHostId: null,
  getKnownWorktreeById: () => undefined
}

const defaultStoreState = {
  updateWorktreeMeta: vi.fn(),
  setWorktreesPinnedAndReveal: vi.fn(),
  workspaceStatuses: DEFAULT_WORKSPACE_STATUSES,
  openModal: vi.fn(),
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
  repos: [],
  ...activeWorkspaceStub
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof defaultStoreState) => unknown) => selector(defaultStoreState),
    {
      getState: () => defaultStoreState
    }
  )
}))

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [],
  useRepoById: (repoId?: string) =>
    repoId ? { id: repoId, name: repoId, displayName: repoId } : undefined,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => new Map()
}))

vi.mock('./ProjectGroupNameDialog', () => ({
  ProjectGroupNameDialog: () => null
}))

vi.mock('./WorktreeParentPickerPopover', () => ({
  WorktreeParentPickerPopover: () => null
}))

vi.mock('./WorktreeDeveloperMenu', () => ({
  WorktreeDeveloperMenu: () => null
}))

vi.mock('./WorktreeOpenInMenu', () => ({
  WorktreeOpenInSubMenu: () => null
}))

vi.mock('./WorkspaceSleepMenuItems', () => ({
  WorkspaceSleepMenuItems: () => null
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderContextMenu(
  worktree: Worktree,
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: string) => void,
  onContextMenuSelect?: () => readonly Worktree[]
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <WorktreeContextMenu
        worktree={worktree}
        onAssignWorkspaceStatus={onAssignWorkspaceStatus}
        onContextMenuSelect={onContextMenuSelect}
      >
        <div data-testid="card-child">Card Content</div>
      </WorktreeContextMenu>
    )
  })
  mounted.push({ container, root })
  return container
}

describe('WorktreeContextMenu delete shortcut display', () => {
  beforeEach(() => {
    shortcutLabelMock.mockImplementation((action: string) => {
      if (action === 'workspace.delete') {
        return '⌘⇧⌫'
      }
      return null
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

  it('renders the delete shortcut badge for standard worktree delete', () => {
    const worktree = {
      id: 'repo::wt-1',
      repoId: 'repo',
      name: 'wt-1',
      path: '/path/to/wt-1',
      isMainWorktree: false
    } as unknown as Worktree

    const container = renderContextMenu(worktree)
    const target = container.querySelector('[data-worktree-context-menu-scope]') as HTMLElement
    expect(target).toBeTruthy()
    act(() => {
      target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })

    const shortcuts = container.querySelectorAll('[data-testid="dropdown-menu-shortcut"]')
    const deleteShortcuts = Array.from(shortcuts).filter((el) => el.textContent === '⌘⇧⌫')
    expect(deleteShortcuts.length).toBe(1)
  })

  it('omits the delete shortcut on disabled Delete Worktree for primary checkout', () => {
    const worktree = {
      id: 'repo-1::main',
      repoId: 'repo-1',
      name: 'main',
      path: '/path/to/main',
      isMainWorktree: true
    } as unknown as Worktree

    const container = renderContextMenu(worktree)
    const target = container.querySelector('[data-worktree-context-menu-scope]') as HTMLElement
    act(() => {
      target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })

    const shortcuts = container.querySelectorAll('[data-testid="dropdown-menu-shortcut"]')
    const deleteShortcuts = Array.from(shortcuts).filter((el) => el.textContent === '⌘⇧⌫')
    expect(deleteShortcuts.length).toBe(0)
  })

  it('omits the shortcut badge when the action is unassigned', () => {
    shortcutLabelMock.mockReturnValue(null)
    const worktree = {
      id: 'repo::wt-1',
      repoId: 'repo',
      name: 'wt-1',
      path: '/path/to/wt-1',
      isMainWorktree: false
    } as unknown as Worktree

    const container = renderContextMenu(worktree)
    const target = container.querySelector('[data-worktree-context-menu-scope]') as HTMLElement
    act(() => {
      target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })

    const shortcuts = container.querySelectorAll('[data-testid="dropdown-menu-shortcut"]')
    expect(shortcuts.length).toBe(0)
  })
})

describe('WorktreeContextMenu mark-Done shortcut display', () => {
  const inProgressWorktree: Worktree = {
    ...worktreeFixture,
    id: 'repo::wt-1',
    repoId: 'repo',
    path: '/path/to/wt-1',
    isMainWorktree: false,
    workspaceStatus: 'in-progress'
  }

  function openMenuShortcuts(container: HTMLDivElement): string[] {
    const target = container.querySelector('[data-worktree-context-menu-scope]') as HTMLElement
    act(() => {
      target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
    return Array.from(
      container.querySelectorAll('[data-testid="dropdown-menu-shortcut"]'),
      (el) => el.textContent ?? ''
    )
  }

  const otherWorktree = { ...inProgressWorktree, id: 'repo::wt-2', name: 'wt-2' }
  const thirdWorktree = { ...inProgressWorktree, id: 'repo::wt-3', name: 'wt-3' }
  const inReviewWorktree = {
    ...inProgressWorktree,
    id: 'repo::wt-4',
    name: 'wt-4',
    workspaceStatus: 'in-review'
  }
  let knownWorktrees: Worktree[] = []

  function setActive(id: string | null, hostId: string | null = null): void {
    defaultStoreState.activeWorktreeId = id
    defaultStoreState.activeWorkspaceExecutionHostId = hostId
  }

  beforeEach(() => {
    shortcutLabelMock.mockImplementation((action: string) =>
      action === 'workspace.markDone' ? 'Del' : null
    )
    knownWorktrees = [inProgressWorktree, otherWorktree, thirdWorktree, inReviewWorktree]
    defaultStoreState.getKnownWorktreeById = (id, hostId) =>
      knownWorktrees.find((w) => w.id === id && (!hostId || (w.hostId ?? 'local') === hostId))
    setActive(inProgressWorktree.id)
  })

  afterEach(() => {
    for (const { root, container } of mounted) {
      act(() => {
        root.unmount()
      })
      container.remove()
    }
    mounted.length = 0
    setActive(null)
    defaultStoreState.deleteStateByWorktreeId = {}
  })

  it('advertises the key on the active row in the sidebar list, which handles it', () => {
    expect(openMenuShortcuts(renderContextMenu(inProgressWorktree))).toEqual(['Del'])
  })

  it('does not advertise the key on a row that is not active, which the key would not move', () => {
    expect(openMenuShortcuts(renderContextMenu(otherWorktree))).toEqual([])
  })

  it('does not advertise the key when the same path is active on another host', () => {
    setActive(inProgressWorktree.id, 'ssh:box')
    expect(openMenuShortcuts(renderContextMenu(inProgressWorktree))).toEqual([])
  })

  it('advertises the key on a multi-row selection, which the key acts on', () => {
    expect(
      openMenuShortcuts(
        renderContextMenu(otherWorktree, undefined, () => [otherWorktree, thirdWorktree])
      )
    ).toEqual(['Del'])
  })

  it('does not advertise the key on the active row when it is not In progress', () => {
    setActive(inReviewWorktree.id)
    expect(openMenuShortcuts(renderContextMenu(inReviewWorktree))).toEqual([])
  })

  it('does not advertise the key on a selection it would only partly move', () => {
    expect(
      openMenuShortcuts(
        renderContextMenu(otherWorktree, undefined, () => [otherWorktree, inReviewWorktree])
      )
    ).toEqual([])
  })

  it('does not advertise the key on a selection row that is mid-delete', () => {
    const deleting = {
      [thirdWorktree.id]: {
        isDeleting: true,
        error: null,
        canForceDelete: false,
        forceDeleteReason: null
      }
    }
    defaultStoreState.deleteStateByWorktreeId = deleting
    expect(
      openMenuShortcuts(
        renderContextMenu(otherWorktree, undefined, () => [otherWorktree, thirdWorktree])
      )
    ).toEqual([])
  })

  it('does not advertise the key on a board card, where it does nothing', () => {
    expect(openMenuShortcuts(renderContextMenu(inProgressWorktree, () => {}))).toEqual([])
  })
})
