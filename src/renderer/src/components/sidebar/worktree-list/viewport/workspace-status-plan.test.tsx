// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorkspaceStatusDefinition } from '../../../../../../shared/worktree/types'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { addHostSectionRows } from '../../../../../../shared/sidebar-list/host-section-rows'
import { makeFolderWorkspace } from '../../../worktree-jump-palette-test-fixtures'
import { createProjectGroup } from '../../../../../../shared/project-groups'
import { getWorkspaceStatusFromGroupKey } from '../../../../../../shared/workspace-statuses'
import { repo, worktree, repoMap } from '../../worktree-list-groups-test-fixtures'
import { buildSidebarRowPlan } from '../grouping/build-rows.test-fixture'
import { buildWorktreeVirtualRowContext } from './virtual-row-context'
import { renderWorktreeVirtualRow } from '../rows/virtual-row-dispatch'
import { INITIAL_REPO_DRAG_STATE } from '../../project-header-drag-contract'
import { INITIAL_PROJECT_GROUP_DRAG_STATE } from '../../project-group-header-drag-contract'

const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

function countedStatuses(size: number) {
  let reads = 0
  const statuses = Array.from({ length: size }, (_, index) => ({
    get id() {
      reads++
      return `status-${index}`
    },
    label: `Status ${index}`,
    icon: 'flag',
    color: 'blue'
  }))
  return {
    statuses,
    reads: () => reads,
    reset: () => {
      reads = 0
    }
  }
}

function headerContext(rows: GroupHeaderRow[], statuses: readonly WorkspaceStatusDefinition[]) {
  const noop = vi.fn()
  const headerDrag = {
    canReorderRepoHeaders: false,
    canReorderProjectGroupHeaders: false,
    orderedHostIds: [],
    hostDrag: {
      state: { draggingHostId: null, dropIndex: null, dropIndicatorY: null },
      onHandlePointerDown: noop
    },
    repoDrag: { state: INITIAL_REPO_DRAG_STATE, onHandlePointerDown: noop },
    projectGroupDrag: { state: INITIAL_PROJECT_GROUP_DRAG_STATE, onHandlePointerDown: noop },
    sidebarRepoHeaderIdsByBucket: new Map(),
    sidebarProjectGroupHeaderIdsByBucket: new Map(),
    repoHeaderIndexByRepoId: new Map(),
    repoHeaderBucketByRepoId: new Map(),
    projectGroupHeaderIndexByGroupId: new Map(),
    projectGroupHeaderBucketByGroupId: new Map(),
    repoHeaderSectionEndByRepoId: new Map(),
    projectGroupHeaderSectionEndByGroupId: new Map()
  }
  // SAFETY: header-only fixture supplies the real builder's inputs; drag/item/virtualizer methods are inert boundary seams, never rendered controls.
  type BuildArgs = Parameters<typeof buildWorktreeVirtualRowContext>[0]
  const partialArgs: { [K in keyof BuildArgs]?: Partial<BuildArgs[K]> } = {
    props: {
      groupBy: 'workspace-status',
      workspaceStatuses: statuses,
      collapsedGroups: new Set(),
      selectedWorktreeIds: new Set(),
      repoMap,
      worktreeMap: new Map()
    },
    projectGroups: [],
    renderRows: rows,
    firstHeaderIndex: 0,
    virtualization: {
      activeStickyHeaderIndexRef: { current: null },
      activeStickyHostIndexRef: { current: null }
    },
    measureVirtualRowElement: noop,
    settings: initial.settings,
    projectActions: {},
    newCardStyle: false,
    folderBackedProjectGroupIds: new Set(),
    session: {},
    runtime: {},
    primaryActive: {},
    reveal: {},
    statusDrag: {},
    nativeDrag: {},
    projectHeaderHostContexts: new Map(),
    headerDrag,
    getCachedFolderWorkspacePathStatus: noop,
    getLineageToggleHandler: noop,
    toggleGroupWithScrollAnchor: noop,
    onRowClickCapture: noop,
    onRowPointerDown: noop
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: header-only fixture supplies every field read by the production header builder.
  const args = partialArgs as BuildArgs
  return buildWorktreeVirtualRowContext(args)
}

it.each([
  [100, 100, 100],
  [1000, 100, 100],
  [100, 1000, 100],
  [1000, 1000, 100],
  [100, 1000, 1000],
  [1000, 1000, 1000]
])('bounds whole shared plan and common viewport status work G=%i W=%i H=%i', (g, w, h) => {
  const counted = countedStatuses(g)
  const worktrees = Array.from({ length: w }, (_, index) => ({
    ...worktree,
    id: `wt-${index}`,
    workspaceStatus: `status-${index % g}`,
    hostId: `runtime:host-${index % h}` as const
  }))
  const project = createProjectGroup({
    name: 'Folder',
    parentPath: '/folders',
    createdFrom: 'manual',
    tabOrder: 0,
    now: 1
  })
  const folders = Array.from({ length: w }, (_, index) =>
    makeFolderWorkspace({
      id: `folder-${index}`,
      projectGroupId: project.id,
      folderPath: `/folders/${index}`,
      workspaceStatus: `status-${index % g}`
    })
  )
  const args: Parameters<typeof buildSidebarRowPlan> = [
    'workspace-status',
    worktrees,
    repoMap,
    null,
    new Set(),
    undefined,
    counted.statuses
  ]
  args[12] = [project]
  args[18] = folders
  const plan = buildSidebarRowPlan(...args)
  const rows = plan.render(new Set())
  expect(rows.filter((row) => row.type === 'header')).toHaveLength(Math.min(g, w))
  expect(rows.filter((row) => row.type === 'folder-workspace')).toHaveLength(w)
  const hostOptions = Array.from({ length: h }, (_, index) => ({
    id: `runtime:host-${index}` as const,
    kind: 'runtime' as const,
    label: `Host ${index}`,
    detail: '',
    health: 'available' as const
  }))
  const hosted = addHostSectionRows({
    rows,
    hostOptions,
    workspaceHostScope: 'all',
    defaultHostId: 'local',
    localHostLabel: 'Local'
  })
  const headers = hosted.filter((row): row is GroupHeaderRow => row.type === 'header')
  expect(rows.filter((row) => row.type === 'item')).toHaveLength(w)
  expect(headers[0]).toMatchObject({
    key: 'workspace-status:status-0',
    label: 'Status 0',
    icon: { kind: 'workspace-status', status: 'status-0' }
  })
  expect(counted.reads()).toBeGreaterThanOrEqual(g)
  expect(counted.reads()).toBeLessThanOrEqual(12 * (g + w))
  const planReads = counted.reads()
  plan.render(new Set(headers.map((row) => row.key)))
  expect(counted.reads() - planReads).toBeLessThanOrEqual(3 * headers.length)

  counted.reset()
  const ctx = headerContext(headers, counted.statuses)
  expect(ctx.workspaceStatusById).toBe(ctx.header.workspaceStatusById)
  const prepared = counted.reads()
  expect(prepared).toBeGreaterThanOrEqual(g)
  expect(prepared).toBeLessThanOrEqual(3 * g)
  const has = vi.spyOn(ctx.workspaceStatusById!, 'has')
  const get = vi.spyOn(ctx.workspaceStatusById!, 'get')
  const view = render(
    <TooltipProvider>
      {headers.map((row, index) =>
        renderWorktreeVirtualRow(ctx, row, {
          key: `${row.type === 'header' ? row.key : row.type}:${index}`,
          index,
          start: index * 35,
          size: 35,
          end: (index + 1) * 35,
          lane: 0
        })
      )}
    </TooltipProvider>
  )
  expect(view.getAllByRole('button')).toHaveLength(headers.length)
  expect(counted.reads() - prepared).toBeLessThanOrEqual(2 * headers.length)
  expect(has.mock.calls.length).toBe(headers.length)
  expect(get.mock.calls.length).toBe(headers.length)
  process.stdout.write(
    `PG6-H ${JSON.stringify({ g, w, h, headerCount: headers.length, planReads, prepReads: prepared, paintReads: counted.reads() - prepared, queries: has.mock.calls.length + get.mock.calls.length })}\n`
  )
})

it('retains first definition, decoder/default behavior and real header invalidation with separate store acts', async () => {
  const statuses = [
    { id: 'first', label: 'First', icon: 'flag', color: 'blue' },
    { id: 'in-progress', label: 'Doing', icon: 'circle', color: 'amber' },
    { id: 'first', label: 'Duplicate', icon: 'ban', color: 'rose' }
  ]
  useAppStore.setState({ workspaceStatuses: statuses })
  let renders = 0
  const toggle = vi.fn()
  function Viewport() {
    const current = useAppStore((state) => state.workspaceStatuses)
    const ctx = useMemo(() => {
      const plan = buildSidebarRowPlan(
        'workspace-status',
        [
          { ...worktree, id: 'known', workspaceStatus: 'first' },
          { ...worktree, id: 'missing', workspaceStatus: 'missing' }
        ],
        repoMap,
        null,
        new Set(),
        undefined,
        current
      )
      const headers = plan
        .render(new Set())
        .filter((row): row is GroupHeaderRow => row.type === 'header')
      const context = headerContext(headers, current)
      context.header.toggleGroupWithScrollAnchor = toggle
      return context
    }, [current])
    renders++
    return (
      <TooltipProvider>
        {ctx.renderRows.map((row, index) =>
          renderWorktreeVirtualRow(ctx, row, {
            key: `${row.type === 'header' ? row.key : row.type}:${index}`,
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
  const view = render(<Viewport />)
  await act(async () => {})
  expect(view.getAllByRole('button', { name: 'First' }).length).toBeGreaterThan(0)
  expect(view.queryByRole('button', { name: 'Duplicate' })).toBeNull()
  expect(view.getByRole('button', { name: 'Doing' })).toBeTruthy()
  fireEvent.click(view.getAllByRole('button', { name: 'First' })[0]!)
  expect(toggle).toHaveBeenLastCalledWith('workspace-status:first')
  const settled = renders
  act(() => useAppStore.setState({ activeRepoId: 'unrelated' }))
  expect(renders).toBe(settled)
  act(() =>
    useAppStore.setState({ settings: { ...getDefaultSettings(''), projectGroupingMode: 'folder' } })
  )
  expect(renders).toBe(settled)
  act(() => useAppStore.setState({ repos: [{ ...repo, executionHostId: 'runtime:other' }] }))
  expect(renders).toBe(settled)
  act(() =>
    useAppStore.setState({
      workspaceStatuses: [
        { ...statuses[0]!, label: 'Renamed', color: 'rose', icon: 'ban' },
        statuses[1]!
      ]
    })
  )
  expect(view.getByRole('button', { name: 'Renamed' })).toBeTruthy()
  expect(view.container.querySelector('.text-rose-600')).toBeTruthy()
  expect(renders).toBeGreaterThan(settled)
  act(() => useAppStore.setState({ workspaceStatuses: [statuses[1]!] }))
  expect(view.queryByRole('button', { name: 'Renamed' })).toBeNull()
  expect(view.getByRole('button', { name: 'Doing' })).toBeTruthy()
  const ctx = headerContext([], statuses)
  for (const key of [
    'workspace-status:%',
    'not-workspace-status:first',
    'workspace-status:unknown'
  ]) {
    expect(getWorkspaceStatusFromGroupKey(key, statuses, ctx.workspaceStatusById)).toBeNull()
  }
  for (const current of [[], [statuses[0]!]]) {
    const plan = buildSidebarRowPlan(
      'workspace-status',
      [{ ...worktree, workspaceStatus: 'unknown' }],
      repoMap,
      null,
      new Set(),
      undefined,
      current
    )
    const row = plan.render(new Set()).find((row) => row.type === 'header')
    // The existing array-order lane emitter emits no sections for an empty definition list.
    expect(row?.key).toBe(current.length ? 'workspace-status:first' : undefined)
  }
})
