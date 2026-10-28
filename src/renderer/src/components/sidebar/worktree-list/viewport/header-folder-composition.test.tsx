// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeRepo, makeFolderWorkspace } from '../../../worktree-jump-palette-test-fixtures'
import { createProjectGroup } from '../../../../../../shared/project-groups'
import type { Repo } from '../../../../../../shared/repo-types'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { useFolderWorkspacePathStatusRows } from '../listing/use-folder-path-statuses'
import { useProjectHeaderHostContexts } from './use-project-header-host-contexts'
import {
  renderWorktreeVirtualRow,
  type WorktreeVirtualRowContext
} from '../rows/virtual-row-dispatch'
import type { SectionHeaderRowContext } from '../rows/SectionHeader'
import { INITIAL_REPO_DRAG_STATE } from '../../project-header-drag-contract'
import { INITIAL_PROJECT_GROUP_DRAG_STATE } from '../../project-group-header-drag-contract'
import { environment, publish, ssh } from '../listing/host-status-test-fixtures'

const initial = useAppStore.getInitialState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('composes real dispatched headers, current repo gates and folder cache refresh without unrelated viewport work', async () => {
  useAppStore.setState(initial, true)
  const group = {
    ...createProjectGroup({
      name: 'Repo',
      parentPath: '/folders',
      createdFrom: 'folder-scan',
      tabOrder: 0,
      now: 1
    }),
    id: 'root',
    executionHostId: 'local'
  }
  const nestedGroup = { ...group, id: 'nested', parentGroupId: 'root', parentPath: null }
  const repo: Repo = { ...makeRepo(), executionHostId: 'runtime:A', connectionId: 'target-0' }
  const nested: Repo = {
    ...makeRepo(),
    id: 'nested-repo',
    path: '/elsewhere/repo',
    projectGroupId: 'nested',
    connectionId: 'nested-A',
    executionHostId: 'local'
  }
  const folder = makeFolderWorkspace({
    projectGroupId: 'root',
    folderPath: '/folders/workspace',
    executionHostId: 'local'
  })
  const projectGroups = [group, nestedGroup]
  const folderWorkspaces = [folder]
  const repoMap = new Map<string, Repo>([
    [repo.id, repo],
    [nested.id, nested]
  ])
  useAppStore.setState({
    repos: [repo, nested],
    projectGroups,
    folderWorkspaces,
    runtimeEnvironments: [environment('A'), environment('B')]
  })
  publish('A', 1)
  publish('B', 1)
  useAppStore.getState().setEnvironmentSshTargetsMetadata('A', [])
  useAppStore
    .getState()
    .setEnvironmentSshConnectionState('A', 'target-0', ssh('connected', 'target-0'))
  let exists = false
  const getPathStatus = vi.fn(async () => ({
    path: '/folders',
    exists,
    ...(exists ? {} : { reason: 'missing' as const })
  }))
  // External filesystem boundary only; request, routing, cache and reader stay real.
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ...window.api, folderWorkspaces: { ...window.api?.folderWorkspaces, getPathStatus } }
  })
  const fetch = vi.fn(useAppStore.getState().fetchFolderWorkspacePathStatus)
  useAppStore.setState({ fetchFolderWorkspacePathStatus: fetch })
  const allRepoIds = [repo.id, nested.id]
  const rows: GroupHeaderRow[] = [
    { type: 'header', key: 'repo', label: 'Repo', icon: { kind: 'project' }, count: 1, repo },
    {
      type: 'header',
      key: 'folder',
      label: 'Repo',
      icon: { kind: 'project' },
      count: 1,
      projectGroup: group
    }
  ]
  const hosts = [
    {
      id: 'local' as const,
      label: 'Local',
      kind: 'local' as const,
      detail: '',
      health: 'available' as const
    },
    {
      id: 'runtime:A' as const,
      label: 'A',
      kind: 'runtime' as const,
      detail: '',
      health: 'available' as const
    }
  ]
  const create = vi.fn()
  const toggle = vi.fn()
  const measure = vi.fn()
  let viewportRenders = 0
  function Viewport({ rows }: { rows: GroupHeaderRow[] }) {
    viewportRenders++
    const getCachedFolderWorkspacePathStatus = useFolderWorkspacePathStatusRows({
      allRepoIds,
      repoMap,
      projectGroups,
      folderWorkspaces
    })
    const projectHeaderHostContexts = useProjectHeaderHostContexts({ rows, hosts, repoMap })
    const header: SectionHeaderRowContext = {
      groupBy: 'repo',
      collapsedGroups: new Set(),
      workspaceStatuses: [],
      projectGroups,
      highlightedRevealRowKey: null,
      dragOverStatus: null,
      pinDragOver: false,
      projectHeaderHostContexts,
      getCachedFolderWorkspacePathStatus,
      toggleGroupWithScrollAnchor: toggle,
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
        onCreateForRepo: create
      },
      onRenameProjectGroup: vi.fn(),
      onDeleteProjectGroup: vi.fn(),
      onCreateFolderWorkspace: create,
      onWorkspaceStatusDragOver: vi.fn(),
      onWorkspaceStatusDragLeave: vi.fn(),
      onWorkspacePinDragOver: vi.fn(),
      onWorkspacePinDragLeave: vi.fn(),
      onWorkspaceStatusDrop: vi.fn()
    }
    const ctx: WorktreeVirtualRowContext = {
      renderRows: rows,
      firstHeaderIndex: 0,
      activeStickyHeaderIndexRef: { current: 0 },
      activeStickyHostIndexRef: { current: null },
      measureVirtualRowElement: measure,
      header,
      groupBy: header.groupBy,
      workspaceStatuses: header.workspaceStatuses,
      activeWorktreeId: null,
      orderedHostIds: header.headerDrag.orderedHostIds,
      hostDrag: header.headerDrag.hostDrag,
      toggleGroupWithScrollAnchor: toggle,
      importedWorktreeCardActionState: new Map(),
      newExternalWorktreeInboxActionState: new Map(),
      onShowImportedWorktrees: vi.fn(),
      onKeepImportedWorktreesHidden: vi.fn(),
      onOpenWorktreeVisibility: header.projectActions.onOpenWorktreeVisibility,
      onOpenSuppressExternalWorktreeInbox: vi.fn(),
      onWorkspaceStatusDragOver: header.onWorkspaceStatusDragOver,
      onWorkspaceStatusDragLeave: header.onWorkspaceStatusDragLeave,
      onWorkspaceStatusDrop: header.onWorkspaceStatusDrop,
      get worktreeDragState(): WorktreeVirtualRowContext['worktreeDragState'] {
        throw new Error('Header fixture cannot read worktree drag state')
      },
      get item(): WorktreeVirtualRowContext['item'] {
        throw new Error('Header fixture cannot render worktree items')
      },
      get folderWorkspace(): WorktreeVirtualRowContext['folderWorkspace'] {
        throw new Error('Header fixture cannot render folder workspace rows')
      }
    }
    return (
      <TooltipProvider>
        {rows.map((row, index) =>
          renderWorktreeVirtualRow(ctx, row, {
            key: row.key,
            index,
            start: index * 35,
            size: 35,
            end: (index + 1) * 35,
            lane: 0
          })
        )}
      </TooltipProvider>
    )
  }
  const view = render(<Viewport rows={rows} />)
  await act(async () => {})
  expect(view.getByRole('button', { name: 'Repo — A' })).toBeTruthy()
  expect(view.getByRole('button', { name: 'Repo — Local' })).toBeTruthy()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls.map(([request, options]) => [request.scope, options])).toEqual([
    ['project-group', { force: true, runtimeEnvironmentId: null }],
    ['folder-workspace', { force: true, runtimeEnvironmentId: null }]
  ])
  const folderButton = () => view.getByRole('button', { name: 'Create workspace for Repo' })
  expect(folderButton().getAttribute('aria-disabled')).toBe('true')
  const settled = viewportRenders
  for (let index = 0; index < 10; index++) {
    act(() =>
      useAppStore.setState({
        sshConnectionStates: new Map([['B', ssh(index % 2 ? 'connected' : 'disconnected', 'B')]])
      })
    )
    act(() => publish('B', index + 2))
  }
  expect(viewportRenders).toBe(settled)
  expect(fetch).toHaveBeenCalledTimes(2)
  act(() =>
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState('A', 'target-0', ssh('disconnected', 'target-0'))
  )
  expect(
    view
      .getByRole('button', { name: 'Reconnect SSH target before creating workspaces for Repo' })
      .hasAttribute('disabled')
  ).toBe(true)
  expect(viewportRenders).toBe(settled)
  exists = true
  await act(async () => {
    useAppStore.setState({
      sshConnectionStates: new Map([['nested-A', ssh('connected', 'nested-A')]])
    })
  })
  expect(fetch).toHaveBeenCalledTimes(4)
  expect(getPathStatus).toHaveBeenCalledTimes(4)
  expect(folderButton().getAttribute('aria-disabled')).toBe('false')
  fireEvent.click(folderButton())
  expect(create).toHaveBeenCalledExactlyOnceWith(group)
  expect(toggle).not.toHaveBeenCalled()
  expect(measure).toHaveBeenCalled()
  expect(
    view.container
      .querySelector('[data-worktree-virtual-row-key="repo"]')
      ?.getAttribute('data-worktree-sticky-header-active')
  ).toBe('')
  // Reuse the virtual row key for another owner: the mounted JSX control reads its new resource.
  view.rerender(
    <Viewport rows={[{ ...rows[0]!, repo: { ...repo, executionHostId: 'runtime:B' } }, rows[1]!]} />
  )
  expect(
    view.getByRole('button', { name: 'Create new worktree for Repo' }).hasAttribute('disabled')
  ).toBe(false)
})

it('keeps empty requests inert, deduplicates owner routes and still fetches null snapshots', () => {
  useAppStore.setState(initial, true)
  const group = {
    ...createProjectGroup({
      name: 'Folder',
      parentPath: '/folders',
      createdFrom: 'folder-scan',
      tabOrder: 0,
      now: 1
    }),
    id: 'root',
    executionHostId: 'local'
  }
  const fetch = vi.fn(async () => null)
  useAppStore.setState({ fetchFolderWorkspacePathStatus: fetch })
  const empty: Parameters<typeof useFolderWorkspacePathStatusRows>[0] = {
    allRepoIds: [],
    repoMap: new Map(),
    projectGroups: [],
    folderWorkspaces: []
  }
  let renders = 0
  const { result, rerender } = renderHook(
    (args) => {
      renders++
      return useFolderWorkspacePathStatusRows(args)
    },
    { initialProps: empty }
  )
  const first = result.current
  const settled = renders
  for (let index = 0; index < 10; index++) {
    act(() =>
      useAppStore.setState({
        sshConnectionStates: new Map([[`outside-${index}`, ssh('connected')]])
      })
    )
  }
  expect(fetch).not.toHaveBeenCalled()
  expect(result.current).toBe(first)
  expect(renders).toBe(settled)
  // Props can route the request before its catalog scope lands; null is not admission.
  rerender({ ...empty, projectGroups: [group, group] })
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    { scope: 'project-group', projectGroupId: 'root' },
    { force: true, runtimeEnvironmentId: null }
  )
  rerender({ ...empty, projectGroups: [{ ...group, executionHostId: 'runtime:A' }] })
  expect(fetch).toHaveBeenLastCalledWith(
    { scope: 'project-group', projectGroupId: 'root' },
    { force: true, runtimeEnvironmentId: 'A' }
  )
  expect(fetch).toHaveBeenCalledTimes(2)
  act(() => useAppStore.setState({ projectGroups: [{ ...group, executionHostId: 'runtime:A' }] }))
  expect(fetch).toHaveBeenCalledTimes(3)
  rerender(empty)
  act(() => useAppStore.setState({ projectGroups: [], sshConnectionStates: new Map() }))
  expect(fetch).toHaveBeenCalledTimes(3)
})
