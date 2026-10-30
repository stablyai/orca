// @vitest-environment happy-dom
import {
  reads,
  deferredIssueSetters,
  task,
  store,
  listArgs,
  read,
  loadingHook,
  source
} from './task-page-linear-refresh-test-fixtures'
import { LinearIssueProjectSelector } from '../../linear-issue-project-selector'
import { syncWorkspaceBoardTaskStatuses } from '../../sidebar/workspace-board-task-status-sync'
import { readWorkspaceReferenceDetails } from '../../sidebar/workspace-reference-detail-read'
import { getWorkspaceReferenceRequest } from '../../sidebar/workspace-reference-details'
import { referenceWorkspace } from '../../sidebar/workspace-reference-fixtures.test-support'
import { LinearIssueSubIssues } from '../../linear-issue-sub-issues'
import { createWorktreeJumpPaletteWorktreeHandler } from '../../worktree-jump-palette-create-worktree'
import {
  mapLinearIssueRead,
  pendingLinearIssueWrites
} from '@/store/slices/linear/linear-issue-publication'
import { writeLinearIssue } from '@/lib/linear-issue-write'
import { useLinearIssuePublication } from '@/hooks/useLinearIssuePublication'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { useState } from 'react'
import LinearItemDrawer from '../../LinearItemDrawer'
import { useTaskPageLinearBoard } from './use-task-page-linear-board'
import { useTaskPageLinearIssueCreation } from './use-task-page-linear-issue-creation'
import { useLinearIssueCreationForm } from './use-task-page-linear-creation-state'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import { useTaskPageDetailRouting } from '../use-task-page-detail-routing'
import { useLinearIssueWorkspaceDetail } from '../../linear-issue-workspace-detail-state'
import { expect, it, vi } from 'vitest'
import { act, renderHook, waitFor, render, fireEvent, screen } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear-slice-test-harness'
import { clearLinearRequestMaps } from '../../../store/slices/linear/linear-slice-request-state'

const schedules = [
  { order: ['A', 'B'], a: true, b: true, interim: 'VB', final: 'VB' },
  { order: ['A', 'B'], a: false, b: true, interim: 'VB', final: 'VB' },
  { order: ['A', 'B'], a: true, b: false, interim: 'VB', final: 'VA' },
  { order: ['A', 'B'], a: false, b: false, interim: 'VB', final: 'In Review' },
  { order: ['B', 'A'], a: true, b: true, interim: 'VB', final: 'VB' },
  { order: ['B', 'A'], a: false, b: true, interim: 'VB', final: 'VB' },
  { order: ['B', 'A'], a: true, b: false, interim: 'VA', final: 'VA' },
  { order: ['B', 'A'], a: false, b: false, interim: 'VA', final: 'In Review' }
]

it.each(
  ['W/W', 'L/W', 'omitted/W', 'omitted/omitted'].flatMap((identity) =>
    schedules.map((schedule) => ({ identity, ...schedule }))
  )
)(
  '$identity $order A=$a B=$b derives $interim then $final for cache and mounted local setter',
  async ({ identity, order, a, b, interim, final }) => {
    const s = store()
    reads.list.mockResolvedValue({ items: [task(), { ...task(), workspaceId: 'L' }] })
    await read(s, 'list')
    const source = defaultScopeSource(s.getState().settings)
    const local = renderHook(() => {
      return useLinearIssuePublication(task(), source).issue!
    })
    const pending = { A: deferred<{ ok: boolean }>(), B: deferred<{ ok: boolean }>() }
    const workspaceIds =
      identity === 'W/W'
        ? ['w', 'w']
        : identity === 'L/W'
          ? ['L', 'w']
          : identity === 'omitted/W'
            ? [undefined, 'w']
            : [undefined, undefined]
    let A!: Promise<{ ok: boolean }>, B!: Promise<{ ok: boolean }>
    act(() => {
      A = writeLinearIssue(
        { ...task(), workspaceId: workspaceIds[0] },
        { state: task('VA').state },
        source,
        () => pending.A.promise
      )
      B = writeLinearIssue(
        { ...task('VA'), workspaceId: workspaceIds[1] },
        { state: task('VB').state },
        source,
        () => pending.B.promise
      )
    })
    expect(local.result.current.state.name).toBe('VB')
    const first = order[0] === 'A' ? 'A' : 'B'
    const second = order[1] === 'A' ? 'A' : 'B'
    await act(async () => {
      pending[first].resolve({ ok: first === 'A' ? a : b })
      await (first === 'A' ? A : B)
    })
    expect(local.result.current.state.name).toBe(interim)
    await act(async () => {
      pending[second].resolve({ ok: second === 'A' ? a : b })
      await Promise.all([A, B])
    })
    expect(local.result.current.state.name).toBe(final)
    const cached = s.getState().getCachedLinearIssues(listArgs)
    expect(
      !Array.isArray(cached) && cached?.items.map((row) => [row.workspaceId, row.state.name])
    ).toEqual([
      ['w', final],
      ['L', final]
    ])
    reads.list.mockResolvedValue({ items: [task('External')] })
    const external = await read(s, 'list')
    expect(!Array.isArray(external) && external?.items[0].state.name).toBe('External')
  }
)

it('real drawer hydration, field controller and text writer compose rollback without permanent masks', async () => {
  const s = store()
  s.setState({
    recordFeatureInteraction: vi.fn(),
    linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'B' }
  })
  const old = deferred<LinearIssue | null>(),
    fresh = deferred<LinearIssue | null>()
  reads.detail.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const priority = deferred<{ ok: boolean }>(),
    labels = deferred<{ ok: boolean }>(),
    title = deferred<{ ok: boolean }>()
  reads.update.mockImplementation((_source, _id, patch) =>
    'priority' in patch ? priority.promise : 'labelIds' in patch ? labels.promise : title.promise
  )
  render(<LinearItemDrawer issue={task()} onUse={vi.fn()} onClose={vi.fn()} />)
  expect(reads.detail).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Priority' }))
  fireEvent.click(screen.getByRole('button', { name: 'Label' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Issue title' }), {
    target: { value: 'Local title' }
  })
  fireEvent.blur(screen.getByRole('textbox', { name: 'Issue title' }))
  expect(reads.update).toHaveBeenCalledWith(
    expect.anything(),
    task().id,
    { labelIds: ['bug'] },
    'w'
  )
  expect(screen.getByTestId('drawer').textContent).toBe('In Review:4:Bug')
  await act(async () => {
    old.resolve(task('Stale'))
    await old.promise
    labels.resolve({ ok: true })
    await labels.promise
  })
  expect(screen.getByTestId('drawer').textContent).toBe('In Review:4:Bug')
  await act(async () => {
    await writeLinearIssue(
      task(),
      { title: 'Sibling title' },
      defaultScopeSource(null),
      async () => ({ ok: true })
    )
  })
  await act(async () => {
    priority.resolve({ ok: false })
    title.resolve({ ok: false })
    await Promise.all([priority.promise, title.promise])
  })
  expect(screen.getByTestId('drawer').textContent).toBe('In Review:0:Bug')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Issue title' }).value).toBe(
    'Sibling title'
  )
  expect(reads.detail).toHaveBeenCalledTimes(2)
  await act(async () => {
    fresh.resolve({
      ...task('External'),
      title: 'Server title',
      priority: 2,
      labels: [],
      labelIds: []
    })
    await fresh.promise
  })
  expect(screen.getByTestId('drawer').textContent).toBe('External:2:')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Issue title' }).value).toBe(
    'Server title'
  )
})

it('confirmed project selection retires old hydration and publishes through the mounted detail consumer', async () => {
  store()
  const old = deferred<LinearIssue | null>(),
    external = deferred<LinearIssue | null>()
  const pending = deferred<{ ok: boolean }>()
  reads.detail.mockReturnValueOnce(old.promise).mockReturnValueOnce(external.promise)
  reads.projects.mockResolvedValue({ items: [{ id: 'chosen', name: 'Chosen' }] })
  reads.update.mockReturnValueOnce(pending.promise)
  function Detail() {
    const detail = useLinearIssueWorkspaceDetail({
      issue: task(),
      providerSettings: defaultScopeSource(null),
      requestKey: 'project'
    })
    return (
      <>
        <output data-testid="project">{detail.displayed.project?.name ?? 'None'}</output>
        <LinearIssueProjectSelector issue={detail.displayed} />
      </>
    )
  }
  render(<Detail />)
  fireEvent.click(screen.getByRole('button', { name: 'Add to project' }))
  fireEvent.change(screen.getByPlaceholderText('Search projects'), { target: { value: 'Chosen' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Chosen' }))
  expect(screen.getByTestId('project').textContent).toBe('None')
  expect(reads.update).toHaveBeenCalledWith(
    defaultScopeSource(null),
    task().id,
    { projectId: 'chosen' },
    'w'
  )
  await act(async () => {
    pending.resolve({ ok: true })
    await pending.promise
  })
  expect(screen.getByTestId('project').textContent).toBe('Chosen')
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(reads.detail).toHaveBeenCalledTimes(2)
  await act(async () => {
    old.resolve(task())
    await old.promise
  })
  expect(screen.getByTestId('project').textContent).toBe('Chosen')
  await act(async () => {
    external.resolve({ ...task(), project: { id: 'external', name: 'External' } })
    await external.promise
  })
  expect(screen.getByTestId('project').textContent).toBe('External')
})

it('confirmed workspace-board sync retires a real crossing loader and accepts its replacement', async () => {
  const s = store()
  const worktreeKey = getWorktreeHostIdentity({ id: 'tree', hostId: 'local' })
  reads.list.mockResolvedValueOnce({ items: [task()] })
  await read(s, 'list')
  const old = deferred<{ items: LinearIssue[] }>(),
    replacement = deferred<{ items: LinearIssue[] }>()
  reads.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise)
  const hook = loadingHook(s)
  await waitFor(() => expect(reads.list).toHaveBeenCalledTimes(2))
  await act(async () => {
    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeKeys: [worktreeKey],
      targetStatus: { id: 'done', label: 'Done' },
      worktreesByKey: new Map([
        [worktreeKey, { linkedLinearIssue: task().identifier, linkedLinearIssueWorkspaceId: 'w' }]
      ]),
      settings: { kind: 'local' },
      getLatestWorkspaceStatus: () => 'done',
      deps: {
        getIssue: async () => task(),
        teamStates: async () => [
          { id: 'done', name: 'Done', type: 'completed', color: '#888888', position: 1 }
        ],
        updateIssue: async () => ({ ok: true })
      }
    })
    expect(result.updated).toBe(1)
  })
  expect(reads.list).toHaveBeenCalledTimes(3)
  await act(async () => {
    old.resolve({ items: [task('Old')] })
    await old.promise
  })
  expect(hook.result.current.displayed[0].state.name).toBe('In Review')
  await act(async () => {
    replacement.resolve({ items: [task('Done')] })
    await replacement.promise
  })
  expect(hook.result.current.displayed[0].state.name).toBe('Done')
  expect(hook.result.current.error).toBeNull()
  expect(hook.result.current.loading).toBe(false)
})

it('a consumed detail observation retires that mounted consumer queued rollback', async () => {
  const s = store()
  const local = renderHook(() => useLinearIssuePublication(task(), defaultScopeSource(null)))
  deferredIssueSetters.enabled = true
  const pending = deferred<{ ok: boolean }>()
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(
      task(),
      { priority: 4 },
      defaultScopeSource(null),
      () => pending.promise
    )
  })
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  const queued = deferredIssueSetters.updates.splice(0)
  deferredIssueSetters.enabled = false
  expect(queued).toHaveLength(2)
  reads.detail.mockResolvedValueOnce({ ...task(), priority: 2 })
  const lease = s.getState().fetchLinearIssue(task().id, 'w', { force: true }).acquire()
  const view = await lease.waitForCurrentTerminal()
  act(() => local.result.current.read(lease, view))
  act(() => queued.forEach((deliver) => deliver()))
  expect(local.result.current.issue?.priority).toBe(2)
  expect(pendingLinearIssueWrites.size).toBe(0)
  lease.release()
})

it('real board drop updates selected fallback and rolls it back through domain settlement', async () => {
  const s = store()
  s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
  const pending = deferred<{ ok: boolean }>()
  reads.update.mockReturnValue(pending.promise)
  const hook = renderHook(() => {
    // SAFETY: only Linear routing and board-drop fields are used; other provider/page actions are inert.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const route = useTaskPageDetailRouting({
      pageData: {},
      linearTaskSourceContext: null,
      setDialogWorkItem: vi.fn(),
      openTaskPage: vi.fn()
    } as never)
    const [updating, setUpdating] = useState(new Set<string>())
    // SAFETY: the actual board handler receives its complete drop dependencies.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const board = useTaskPageLinearBoard({
      ...route,
      settings: null,
      invalidateLinearIssueLists: s.getState().invalidateLinearIssueLists,
      linearTaskSourceContext: null,
      linearGroupBy: 'status',
      linearOrderBy: 'identifier',
      setLinearDisplayProperties: vi.fn(),
      setLinearTeamPropertyTouched: vi.fn(),
      linearBoardDraggingIssueId: null,
      setLinearBoardDraggingIssueId: vi.fn(),
      setLinearBoardDragOverKey: vi.fn(),
      linearBoardUpdatingIssueIds: updating,
      setLinearBoardUpdatingIssueIds: setUpdating,
      filteredLinearIssues: [task()],
      pagedLinearIssues: [task()]
    } as never)
    return { route, board }
  })
  act(() => hook.result.current.route.setSelectedLinearIssue(task()))
  let dropping!: Promise<void>
  // SAFETY: board drop reads only these event methods and the typed dataTransfer payload.
  act(() => {
    dropping = hook.result.current.board.handleLinearBoardDrop(
      { key: 'status:done', label: 'Done', issues: [task('Done')] },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
      {
        preventDefault() {},
        stopPropagation() {},
        dataTransfer: { types: ['application/x-orca-linear-issue-id'], getData: () => 'same-uuid' }
      } as unknown as React.DragEvent<HTMLElement>
    )
  })
  await waitFor(() =>
    expect(hook.result.current.route.selectedLinearIssue?.state.name).toBe('Done')
  )
  await act(async () => {
    pending.resolve({ ok: false })
    await dropping
  })
  expect(hook.result.current.route.selectedLinearIssue?.state.name).toBe('In Review')
  expect(hook.result.current.board.linearBoardUpdatingIssueIds.size).toBe(0)
})

it('postcreate hydration follows replacement and respects actual selection-commit authority', async () => {
  const s = store()
  s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
  reads.create.mockResolvedValue({ ok: true, id: task().id, identifier: task().identifier })
  const old = deferred<LinearIssue | null>(),
    replacement = deferred<LinearIssue | null>()
  reads.detail.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise)
  const noop = vi.fn(),
    runtime = { current: 'runtime' }
  const hook = renderHook(() => {
    // SAFETY: routing fixture supplies Linear selection only.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const route = useTaskPageDetailRouting({
      pageData: {},
      linearTaskSourceContext: null,
      setDialogWorkItem: noop,
      openTaskPage: noop
    } as never)
    // SAFETY: the creation hook uses this complete minimal issue-draft model; other project model fields are unused.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const model = useTaskPageLinearIssueCreation({
      ...route,
      settings: null,
      providerRuntimeContextKey: 'runtime',
      providerRuntimeContextKeyRef: runtime,
      linearTaskSourceContext: null,
      setLinearRefreshNonce: noop,
      selectedLinearProject: null,
      ...useLinearIssueCreationForm('runtime', { open: true, title: 'Created', body: '' }),
      newLinearIssueTargetTeam: { id: 'team-1', workspaceId: 'w' }
    } as never)
    return { route, model }
  })
  await act(async () => {
    await hook.result.current.model.handleCreateNewLinearIssue()
  })
  const pending = deferred<{ ok: boolean }>()
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(
      task(),
      { state: task('Done').state },
      defaultScopeSource(null),
      () => pending.promise
    )
  })
  await act(async () => {
    old.resolve(task())
    await old.promise
    pending.resolve({ ok: true })
    await saving
  })
  expect(hook.result.current.route.selectedLinearIssue).toBeNull()
  await act(async () => {
    replacement.resolve(task('External'))
    await replacement.promise
  })
  expect(hook.result.current.route.selectedLinearIssue?.state.name).toBe('External')
})

it('queued Cmd-J activation loses its delivered read token and follows the actual replacement', async () => {
  const s = store()
  s.setState({ activeModal: 'worktree-palette' })
  reads.detail.mockResolvedValueOnce(task('Before'))
  const replacement = deferred<LinearIssue | null>()
  reads.detail.mockReturnValueOnce(replacement.promise)
  const lease = mapLinearIssueRead(
    s.getState().fetchLinearIssue(task().id, 'w', { force: true }),
    (row) => ({
      query: 'url',
      issue: row,
      loading: false,
      initialRepoId: null,
      sourceContext: null
    })
  ).acquire()
  await lease.waitForCurrentTerminal()
  const ref = { current: { query: 'url', lease } }
  const open = vi.fn(),
    close = vi.fn()
  // SAFETY: the Linear branch uses only these dependencies and the real owned preview lease.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
  const handler = createWorktreeJumpPaletteWorktreeHandler({
    createWorktreeName: 'url',
    liveQueryRef: { current: 'url' },
    taskSourceUrl: { provider: 'linear' },
    linearIssueUrlIntent: {},
    linearLookupRef: ref,
    selectionMovedByUserRef: { current: false },
    skipRestoreFocusRef: { current: false },
    prefetchCreateWorkspaceBaseForComposer: vi.fn(),
    closeModal: close,
    openModal: open,
    recordFeatureInteraction: vi.fn()
  } as never)
  const queued: VoidFunction[] = []
  const microtask = vi
    .spyOn(globalThis, 'queueMicrotask')
    .mockImplementation((job) => queued.push(job))
  handler()
  const pending = deferred<{ ok: boolean }>()
  const saving = writeLinearIssue(
    task(),
    { state: task('Done').state },
    defaultScopeSource(null),
    () => pending.promise
  )
  microtask.mockRestore()
  await act(async () => {
    pending.resolve({ ok: true })
    await saving
  })
  for (const commit of queued) {
    commit()
  }
  expect(open).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  await act(async () => {
    replacement.resolve(task('External'))
    await replacement.promise
  })
  expect(open).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledWith(
    'new-workspace-composer',
    expect.objectContaining({
      linkedWorkItem: expect.objectContaining({ linearIdentifier: task().identifier })
    })
  )
  lease.release()
})

it('sidebar hover cancellation releases real demand before pending-write drain', async () => {
  const s = store()
  const origin = source('local')
  const old = deferred<LinearIssue | null>()
  reads.detail.mockReturnValue(old.promise)
  const request = getWorkspaceReferenceRequest(
    {
      provider: 'linear',
      type: 'issue',
      number: 0,
      identifier: task().identifier,
      linearWorkspaceId: 'w',
      url: task().url,
      taskSourceContext: origin
    },
    referenceWorkspace
  )
  const controller = new AbortController()
  const reading = readWorkspaceReferenceDetails(request, controller.signal)
  await waitFor(() => expect(reads.detail).toHaveBeenCalledTimes(1))
  const pending = deferred<{ ok: boolean }>()
  const saving = writeLinearIssue(task(), { priority: 4 }, origin, () => pending.promise)
  controller.abort()
  expect(await reading).toBeNull()
  await act(async () => {
    pending.resolve({ ok: true })
    await saving
    old.resolve(task())
    await old.promise
  })
  expect(reads.detail).toHaveBeenCalledTimes(1)
  expect(Object.keys(s.getState().linearIssueCache)).toHaveLength(0)
})

it.each([false, true])(
  'actual subissue navigation settles retired demand, abandoned=%s',
  async (abandoned) => {
    const s = store()
    const old = deferred<LinearIssue | null>(),
      replacement = deferred<LinearIssue | null>()
    reads.detail.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise)
    const open = vi.fn()
    render(
      <LinearIssueSubIssues
        issue={{
          ...task(),
          subIssues: [{ id: 'child', identifier: 'DAT-2', title: 'Child', url: task().url }]
        }}
        onOpenIssue={open}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /DAT-2 Child/ }))
    const child = { ...task(), id: 'child' }
    const pending = deferred<{ ok: boolean }>()
    const saving = writeLinearIssue(
      child,
      { state: task('Done').state },
      defaultScopeSource(null),
      () => pending.promise
    )
    if (abandoned) {
      act(() => clearLinearRequestMaps())
    }
    await act(async () => {
      old.resolve(child)
      await old.promise
      pending.resolve({ ok: true })
      await saving
    })
    expect(open).not.toHaveBeenCalled()
    await act(async () => {
      replacement.resolve({ ...child, state: task('External').state })
      await replacement.promise
    })
    expect(open).toHaveBeenCalledTimes(abandoned ? 0 : 1)
    if (!abandoned) {
      expect(open.mock.calls[0][0].state.name).toBe('External')
    }
    expect(reads.detail).toHaveBeenCalledTimes(abandoned ? 1 : 2)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /DAT-2 Child/ }).disabled).toBe(
      false
    )
    act(() => s.getState().patchLinearIssue('child', { priority: 2 }))
    expect(open).toHaveBeenCalledTimes(abandoned ? 0 : 1)
  }
)
