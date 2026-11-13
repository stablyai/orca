// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorktreeContextMenu from '../../workspace-actions/context-menu/WorktreeContextMenu'
import type WorktreeCard from '../../workspace-card/surface/WorktreeCard'
import { renderFolderWorkspaceOption, type FolderWorkspaceRowContext } from './folder-row'
import type { FolderWorkspaceItemRow } from '../listing/renderable-rows'
import { WORKTREE_ROW_DRAG_INITIAL_STATE } from '../drag/row-state'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { worktree } from '../grouping/worktree-list-groups-test-fixtures'

// Keep the real menu model/view at the card prop seam; omit unrelated card presentation.
vi.mock('../../workspace-card/surface/WorktreeCard', () => ({
  default: (props: ComponentProps<typeof WorktreeCard>) => (
    <WorktreeContextMenu
      worktree={props.worktree}
      selectedWorktrees={props.selectedWorktrees}
      onContextMenuSelect={(event) =>
        props.onContextMenuSelect?.(event, props.worktree) ?? [props.worktree]
      }
    >
      <span>{props.worktree.displayName}</span>
    </WorktreeContextMenu>
  )
}))

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})
it.each([750, 7500])(
  'does no aggregate selection work for closed folder menus at %i selected rows',
  (size) => {
    const folders: FolderWorkspaceItemRow[] = Array.from({ length: 10 }, (_, index) => ({
      type: 'folder-workspace',
      key: `folder-${index}`,
      depth: 0,
      groupDepth: 0,
      projectGroup: {
        id: 'group',
        name: 'Folders',
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      },
      folderWorkspace: {
        id: `folder-${index}`,
        projectGroupId: 'group',
        name: `Folder ${index}`,
        folderPath: `/tmp/tri35-folder-${index}`,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: index,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
    }))
    let selectedOwnerReads = 0
    const selection = Array.from({ length: size }, (_, index): Worktree => {
      const item =
        index < folders.length
          ? folderWorkspaceToWorktree(folders[index].folderWorkspace)
          : { ...worktree, id: `worktree-${index}` }
      Object.defineProperty(item, 'runtimeOwnerEnvironmentId', {
        get: () => {
          selectedOwnerReads += 1
          return undefined
        }
      })
      return item
    })
    // The list owns this collection; unopened folder menus must not traverse it.
    const ctx: FolderWorkspaceRowContext & { selectedWorktrees: readonly Worktree[] } = {
      groupBy: 'none',
      newCardStyle: false,
      settings: null,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      currentWorktreeId: null,
      selectedWorktreeIds: new Set(folders.map((row) => `local|folder:${row.folderWorkspace.id}`)),
      selectedWorktrees: selection,
      repoMap: new Map(),
      worktreeMap: new Map(),
      worktreeLineageById: {},
      workspaceLineageByChildKey: {},
      crossStoreChildrenByFolderId: new Map(),
      prCache: null,
      hostedReviewCache: null,
      getCachedFolderWorkspacePathStatus: () => null,
      onSelectionGesture: () => false,
      onContextMenuSelect: () => selection,
      onImmediateActivate: () => {},
      onRowClickCapture: () => {},
      onRowPointerDown: () => {},
      worktreeDragState: WORKTREE_ROW_DRAG_INITIAL_STATE,
      nativeLineageDropTargetIdentity: null
    }
    const view = render(
      <TooltipProvider>
        {folders.map((row) => renderFolderWorkspaceOption({ ctx, row }))}
      </TooltipProvider>
    )
    expect(selectedOwnerReads).toBe(0)
    view.rerender(
      <TooltipProvider>
        {folders.map((row) =>
          renderFolderWorkspaceOption({
            ctx: { ...ctx, selectedWorktreeIds: new Set(ctx.selectedWorktreeIds) },
            row
          })
        )}
      </TooltipProvider>
    )
    // Ten mounted folders require zero selected-row owner lookups until a menu opens, at either fleet size.
    expect(selectedOwnerReads).toBe(0)
    const first = view.container.querySelector('[data-worktree-context-menu-scope]')
    if (!(first instanceof HTMLElement)) {
      throw new Error('Missing folder menu scope')
    }
    act(() => fireEvent.contextMenu(first))
    expect(selectedOwnerReads).toBeGreaterThan(0)
  }
)
