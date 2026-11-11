// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Project, ProjectHostSetup } from '../../../../../../shared/project-types'
import type { ProjectSectionModel } from '../../../../../../shared/project-section-grouping'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../../../shared/execution-host'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { addHostSectionRows } from '../../../../../../shared/sidebar-list/host-section-rows'
import { createHostScopedRepoOf } from '../../../../../../shared/sidebar-list/sidebar-feed-index'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import { INITIAL_REPO_DRAG_STATE } from '../drag/project-header-drag-contract'
import { INITIAL_PROJECT_GROUP_DRAG_STATE } from '../drag/project-group-header-drag-contract'
import { openHeaderCreateComposer } from './header-create-workspace-target'
import { resolveWorkspaceCreationTarget } from '@/lib/workspace/creation/project-host-workspace-target'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'
import { renderWorktreeSectionHeaderRow } from './SectionHeader'
import type { SectionHeaderRowContext } from './section-header-row-context'

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
  placeholderRepoIds: ReadonlySet<string> = new Set(),
  view: {
    projectGrouping?: ProjectSectionModel
    /** null: the default all-hosts project view, which draws no host sections. */
    visibleWorkspaceHostIds?: ExecutionHostId[] | null
  } = {}
): GroupHeaderRow {
  const repoMap = new Map([[keptRegistration.id, keptRegistration]])
  const rows = planSidebarRows({
    groupBy: 'repo',
    sortBy: 'smart',
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
    projectGrouping: view.projectGrouping,
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
    visibleWorkspaceHostIds:
      view.visibleWorkspaceHostIds === undefined ? ['local'] : view.visibleWorkspaceHostIds,
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
      projectGroupHeaderSectionEndByGroupId: new Map(),
      rootProjectHeaderKeys: undefined,
      rootProjectHeaderCountByOccurrenceKey: new Map(),
      rootProjectHeaderSectionEndByKey: new Map()
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

function clickCreate(
  row: GroupHeaderRow,
  catalog: Partial<Pick<AppState, 'projects' | 'projectHostSetups'>> = {}
): void {
  useAppStore.setState({ repos: [localTwin, serverTwin], ...catalog })
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
  fireEvent.click(view.getByRole('button', { name: /Create (new worktree|workspace) for/ }))
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

const twinProject: Project = {
  id: 'project-twin',
  displayName: 'Twin',
  badgeColor: '#737373',
  sourceRepoIds: [localTwin.id],
  createdAt: 1,
  updatedAt: 1
}
const twinSetups: ProjectHostSetup[] = [localTwin, serverTwin].map((twin) => ({
  id: `setup-${twin.executionHostId ?? 'local'}`,
  projectId: twinProject.id,
  hostId: twin.executionHostId ?? 'local',
  repoId: twin.id,
  path: twin.path,
  displayName: twin.displayName,
  setupState: 'ready',
  setupMethod: 'legacy-repo',
  createdAt: 1,
  updatedAt: 1
}))
const twinCatalog = { projects: [twinProject], projectHostSetups: twinSetups }

/** Clicks a grouped twin header's Create and returns the opener payload and the composer's scoped target. */
function createFromGroupedHeader(row: GroupHeaderRow, focusedHostScope: ExecutionHostScope) {
  clickCreate(row, twinCatalog)
  return {
    modalData: useAppStore.getState().modalData,
    target: resolveWorkspaceCreationTarget({
      eligibleRepos: [localTwin, serverTwin],
      ...twinCatalog,
      projectScope: row.projectScope,
      focusedHostScope
    })
  }
}
const localTarget = {
  status: 'ready',
  target: { hostId: 'local', projectHostSetupId: 'setup-local' }
}

it("opens an empty grouped twin header's chooser on the composer's focused host, not the registration repoMap kept", () => {
  const header = localOnlyViewHeader([], serverTwin, new Set([localTwin.id]), {
    projectGrouping: twinCatalog
  })
  const { modalData, target } = createFromGroupedHeader(header, 'local')

  expect(modalData).toEqual({
    initialProjectScope: header.projectScope,
    telemetrySource: 'sidebar'
  })
  // Membership alone is not the header's context; checked apart from the target it happens to give.
  expect(header.projectScope).toMatchObject({ key: expect.any(String), context: undefined })
  expect(target).toMatchObject(localTarget)
})

it('keeps a grouped twin header localized to its only visible host on that host, and an unlocalized one on its chooser', () => {
  const localRow = { ...worktree, id: 'wt-local', repoId: localTwin.id }
  const localized = localOnlyViewHeader([localRow], serverTwin, new Set(), {
    projectGrouping: twinCatalog
  })
  expect(localized.hostId).toBe('local')
  expect(createFromGroupedHeader(localized, 'local').modalData).toEqual({
    initialRepoId: localTwin.id,
    initialWorkspaceTarget: {
      projectId: twinProject.id,
      hostId: 'local',
      projectHostSetupId: 'setup-local'
    },
    telemetrySource: 'sidebar'
  })
  cleanup()

  // Retained local registration: no host restriction, so the group chooser keeps the shown local seed.
  const unlocalized = localOnlyViewHeader([localRow], localTwin, new Set(), {
    projectGrouping: twinCatalog
  })
  expect(unlocalized.hostId).toBeUndefined()
  const { modalData, target } = createFromGroupedHeader(unlocalized, 'local')
  expect(modalData).toEqual({
    initialProjectScope: unlocalized.projectScope,
    telemetrySource: 'sidebar'
  })
  expect(unlocalized.projectScope?.context).toEqual({
    repoId: localTwin.id,
    hostId: 'local',
    setupId: 'setup-local'
  })
  expect(target).toMatchObject(localTarget)
})

it("falls to the local member when a grouped twin's retained registration shows none of the rows", () => {
  const header = localOnlyViewHeader(
    [{ ...worktree, id: 'wt-home', repoId: serverTwin.id, hostId: 'runtime:home' }],
    localTwin,
    new Set(),
    { projectGrouping: twinCatalog, visibleWorkspaceHostIds: null }
  )
  const { modalData, target } = createFromGroupedHeader(header, 'all')

  expect(header.hostId).toBeUndefined()
  expect(modalData).toEqual({
    initialProjectScope: header.projectScope,
    telemetrySource: 'sidebar'
  })
  expect(header.projectScope).toMatchObject({ key: expect.any(String), context: undefined })
  expect(target).toMatchObject(localTarget)
})
