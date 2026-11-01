// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { addHostSectionRows } from '../../../../../../shared/sidebar-list/host-section-rows'
import { createHostScopedRepoOf } from '../../../../../../shared/sidebar-list/sidebar-feed-index'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import { INITIAL_REPO_DRAG_STATE } from '../../project-header-drag-contract'
import { INITIAL_PROJECT_GROUP_DRAG_STATE } from '../../project-group-header-drag-contract'
import { openHeaderCreateComposer } from '../../header-create-workspace-target'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import { renderWorktreeSectionHeaderRow, type SectionHeaderRowContext } from './SectionHeader'

const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

// One repo id registered on this computer and on a paired server.
const localTwin: Repo = { ...repo, id: 'repo-twin' }
const serverTwin: Repo = { ...localTwin, path: '/srv/twin', executionHostId: 'runtime:home' }

function localOnlyViewHeader(
  worktrees: Worktree[],
  keptRegistration: Repo,
  placeholderRepoIds: ReadonlySet<string> = new Set()
): GroupHeaderRow {
  const repoMap = new Map([[keptRegistration.id, keptRegistration]])
  const rows = planSidebarRows({
    groupBy: 'repo',
    worktrees,
    repoMap,
    repoOfWorktree: createHostScopedRepoOf([localTwin, serverTwin], repoMap),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    nestLineage: false,
    projectGroups: [],
    placeholderRepoIds,
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: []
  }).render(new Set())
  const header = addHostSectionRows({
    rows,
    hostOptions: [
      { id: 'local', kind: 'local', label: 'Local Mac', detail: '', health: 'local' },
      { id: 'runtime:home', kind: 'runtime', label: 'Home', detail: '', health: 'available' }
    ],
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: ['local'],
    defaultHostId: 'local',
    localHostLabel: 'Local Mac',
    preferProjectGrouping: true
  }).find((row) => row.type === 'header')
  if (!header) {
    throw new Error('the planned view has no project header')
  }
  return header
}

function headerContext(): SectionHeaderRowContext {
  return {
    groupBy: 'repo',
    collapsedGroups: new Set(),
    workspaceStatuses: [],
    projectGroups: [],
    highlightedRevealRowKey: null,
    dragOverStatus: null,
    pinDragOver: false,
    getCachedFolderWorkspacePathStatus: () => null,
    toggleGroupWithScrollAnchor: vi.fn(),
    headerDrag: {
      canReorderRepoHeaders: false,
      canReorderProjectGroupHeaders: false,
      orderedHostIds: [],
      hostDrag: {
        state: { draggingHostId: null, dropIndex: null, dropIndicatorY: null },
        onHandlePointerDown: vi.fn()
      },
      repoDrag: { state: INITIAL_REPO_DRAG_STATE, onHandlePointerDown: vi.fn() },
      projectGroupDrag: { state: INITIAL_PROJECT_GROUP_DRAG_STATE, onHandlePointerDown: vi.fn() },
      sidebarRepoHeaderIdsByBucket: new Map(),
      sidebarProjectGroupHeaderIdsByBucket: new Map(),
      repoHeaderIndexByRepoId: new Map(),
      repoHeaderBucketByRepoId: new Map(),
      projectGroupHeaderIndexByGroupId: new Map(),
      projectGroupHeaderBucketByGroupId: new Map(),
      repoHeaderSectionEndByRepoId: new Map(),
      projectGroupHeaderSectionEndByGroupId: new Map()
    },
    projectActions: {
      getWorktreeVisibilityDefaults: () => undefined,
      onOpenRepoSettings: vi.fn(),
      onOpenWorktreeVisibility: vi.fn(),
      onCreateGroupFromRepo: vi.fn(),
      onMoveProjectToGroup: vi.fn(),
      onRemoveProjectFromGroup: vi.fn(),
      onRemoveProject: vi.fn(),
      onCreateForRepo: openHeaderCreateComposer
    },
    onRenameProjectGroup: vi.fn(),
    onDeleteProjectGroup: vi.fn(),
    onCreateFolderWorkspace: vi.fn(),
    onWorkspaceStatusDragOver: vi.fn(),
    onWorkspaceStatusDragLeave: vi.fn(),
    onWorkspacePinDragOver: vi.fn(),
    onWorkspacePinDragLeave: vi.fn(),
    onWorkspaceStatusDrop: vi.fn()
  }
}

function clickCreate(row: GroupHeaderRow): void {
  useAppStore.setState({ repos: [localTwin, serverTwin] })
  const view = render(
    <TooltipProvider>
      {renderWorktreeSectionHeaderRow({
        ctx: headerContext(),
        row,
        vItem: { key: 'header', index: 0, start: 0, size: 35, end: 35, lane: 0 },
        isActiveStickyHeader: false,
        hasStickyHost: false,
        hasHeaderTopSpacing: false,
        measureVirtualRowElement: vi.fn()
      })}
    </TooltipProvider>
  )
  fireEvent.click(view.getByRole('button', { name: /Create new worktree for/ }))
}

it("opens Create on a same-id twin's own host in a view that shows only that host", () => {
  clickCreate(
    localOnlyViewHeader([{ ...worktree, id: 'wt-local', repoId: localTwin.id }], localTwin)
  )

  expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
  expect(useAppStore.getState().modalData).toMatchObject({
    initialRepoId: localTwin.id,
    initialWorkspaceTarget: { hostId: 'local' }
  })
})

it("leaves an empty twin header to the composer's focused host, not the registration repoMap kept", () => {
  clickCreate(localOnlyViewHeader([], serverTwin, new Set([localTwin.id])))

  expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
  expect(useAppStore.getState().modalData).not.toHaveProperty('initialWorkspaceTarget')
})
