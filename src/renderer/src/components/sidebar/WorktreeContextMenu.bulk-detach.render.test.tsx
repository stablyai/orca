// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, WorktreeLineage } from '../../../../shared/types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Why: this test pins the HANDLER wiring — bulk "Remove from Parent" must dispatch
// noParent only for selected rows that actually carry a parent link. The pure filter
// is covered in WorktreeContextMenu.test.ts; here the real component is mounted so a
// regression that reconnects the handler to the unfiltered selection fails loudly.

const mockState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('@/store', () => {
  const useAppStore = ((selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockState.current)) as ((
    selector: (state: Record<string, unknown>) => unknown
  ) => unknown) & { getState: () => Record<string, unknown> }
  useAppStore.getState = () => mockState.current
  return { useAppStore }
})

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [],
  useRepoById: () => null,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => new Map()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/hooks/useVirtualizedScrollAnchor', () => ({
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT: 'orca:test-record-scroll-anchor'
}))

vi.mock('./delete-worktree-flow', () => ({
  runWorktreeBatchDelete: vi.fn(),
  runWorktreeDelete: vi.fn()
}))

vi.mock('./sleep-worktree-flow', () => ({ runSleepWorktrees: vi.fn() }))

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

vi.mock('./WorktreeOpenInMenu', () => ({ WorktreeOpenInSubMenu: () => null }))
vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))

import WorktreeContextMenu from './WorktreeContextMenu'

function makeWorktree(id: string, displayName: string): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId: 'repo',
    path: `/tmp/bulk-detach/${displayName}`,
    displayName,
    branch: displayName,
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
    sortOrder: 1,
    lastActivityAt: 1
  } as Worktree
}

function makeLineage(childId: string, parentId: string): WorktreeLineage {
  return {
    worktreeId: childId,
    worktreeInstanceId: `${childId}-instance`,
    parentWorktreeId: parentId,
    parentWorktreeInstanceId: `${parentId}-instance`,
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
}

describe('bulk Remove from Parent handler targeting', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('dispatches noParent only for selected rows with a parent link', async () => {
    const parentNoLineage = makeWorktree('repo::parent', 'parent')
    const child = makeWorktree('repo::child', 'child')
    const updateWorktreeLineage = vi.fn(() => Promise.resolve())
    mockState.current = {
      updateWorktreeMeta: vi.fn(),
      setWorktreesPinnedAndReveal: vi.fn(),
      workspaceStatuses: [],
      openModal: vi.fn(),
      projectGroups: [],
      createProjectGroup: vi.fn(),
      moveProjectToGroup: vi.fn(),
      deleteFolderWorkspace: vi.fn(),
      setActiveWorktree: vi.fn(),
      deleteStateByWorktreeId: {},
      worktreeLineageById: { [child.id]: makeLineage(child.id, parentNoLineage.id) },
      workspaceLineageByChildKey: {},
      updateWorktreeLineage,
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      browserTabsByWorktree: {}
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <WorktreeContextMenu worktree={child} selectedWorktrees={[parentNoLineage, child]}>
          <div data-testid="child-row">child row</div>
        </WorktreeContextMenu>
      )
    })

    const row = container.querySelector('[data-testid="child-row"]')
    expect(row).not.toBeNull()
    act(() => {
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })

    const removeFromParent = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Remove from Parent')
    )
    expect(removeFromParent).toBeDefined()
    // Why: the menu suppresses clicks within 500ms of opening (macOS ctrl-click
    // guard); jump past the window so the item click is not swallowed.
    const realNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 1_000)
    try {
      await act(async () => {
        removeFromParent!.click()
        await Promise.resolve()
      })
    } finally {
      nowSpy.mockRestore()
    }

    // The lineage-free parent must NOT receive a detach; only the child carries a link.
    expect(updateWorktreeLineage).toHaveBeenCalledTimes(1)
    expect(updateWorktreeLineage).toHaveBeenCalledWith(child.id, { noParent: true })
  })
})
