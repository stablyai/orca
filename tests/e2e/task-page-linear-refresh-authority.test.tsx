import { useLinearIssueResult } from '@/hooks/linear-issue-committed-state'
// @vitest-environment happy-dom
import {
  reads,
  task,
  store,
  views,
  listArgs,
  read,
  wire,
  response,
  fixture,
  display,
  loadingHook,
  source
} from '../../src/renderer/src/components/task-page/linear/task-page-linear-refresh-test-fixtures'
import { TaskPageLinearIssueTable } from '../../src/renderer/src/components/task-page/linear/IssueTable'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TaskPageComposerActionsModel } from '../../src/renderer/src/components/task-page/use-task-page-composer-actions'
import { useState } from 'react'
import { workspaceFromLinearData } from '../../src/main/linear/linear-workspace-record'
import { credentialDecryptionMessage } from '../../src/shared/integration-credential-errors'
import { writeLinearIssue } from '@/lib/linear-issue-write'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { pendingLinearIssueWrites } from '@/store/slices/linear/linear-issue-publication'
import { PaginationBar } from '../../src/renderer/src/components/task-page/PaginationBar'
import { useTaskPageLinearListProjectionPrelude } from '../../src/renderer/src/components/task-page/linear/use-task-page-linear-list-projection'
import type { LinearIssue } from '../../src/shared/linear/issue-types'
import type { TaskSourceContext } from '../../src/shared/task-source-context'
import { useTaskPageLinearInOrcaEffects } from '../../src/renderer/src/components/task-page/linear/use-task-page-linear-in-orca-effects'
import { useTaskPageDetailRouting } from '../../src/renderer/src/components/task-page/use-task-page-detail-routing'
import { useLinearIssueWorkspaceDetail } from '../../src/renderer/src/components/linear-issue-workspace-detail-state'
import { assert, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor, render, fireEvent, screen } from '@testing-library/react'
import { deferred } from '../../src/renderer/src/store/slices/linear-slice-test-harness'
import { clearLinearRequestMaps } from '../../src/renderer/src/store/slices/linear/linear-slice-request-state'
import { useTaskPageLinearListSelectionPrelude } from '../../src/renderer/src/components/task-page/linear/use-task-page-linear-list-selection'
import { LinearStateCell } from '../../src/renderer/src/components/task-page/linear/task-page-linear-issue-model'
import { getTaskSourceCacheScope } from '../../src/shared/task-source-context'
import { useTaskPageLinearListEffects } from '../../src/renderer/src/components/task-page/linear/use-task-page-linear-list-effects'

const cacheTime = Date.parse('2026-01-01T00:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(cacheTime)
})
afterEach(() => vi.useRealTimers())

describe('Linear refresh row authority', () => {
  it.each(views)(
    '%s displays a successful refresh over expired detail and unrelated search copies',
    async (view) => {
      const s = store()
      s.setState({
        linearIssueCache: { 'w::DAT-124': { data: task(), fetchedAt: 1 } },
        linearSearchCache: { 'w::search::old-query::36': { data: [task()], fetchedAt: 1 } }
      })
      wire(view).mockResolvedValue(response(view, 'Done'))
      const result = await read(s, view)
      assert(result !== null)
      const rows = Array.isArray(result) ? result : result.items
      expect(rows[0].state.name).toBe('Done')
      expect(display(s, rows, view).result.current.displayedLinearIssues[0].state.name).toBe('Done')
    }
  )
})

it.each(['connect', 'test'] as const)(
  '%s acknowledgement without a revision retires the sole workspace decrypt error in Tasks selection',
  async (action) => {
    const s = store()
    reads.list.mockResolvedValue(response('list', 'In Review'))
    const result = await s.getState().listLinearIssues(listArgs, { force: true })
    assert(result !== null)
    const { items } = result
    const workspace = workspaceFromLinearData(
      { displayName: 'User', email: null },
      { id: 'w', name: 'Acme' }
    )
    const message = credentialDecryptionMessage('Linear')
    s.setState({
      linearStatus: {
        connected: true,
        viewer: workspace,
        workspaces: [{ ...workspace, credentialRevision: 1 }],
        activeWorkspaceId: 'w',
        selectedWorkspaceId: 'w',
        credentialError: message
      }
    })
    const acknowledgement = { ok: true, viewer: workspace, workspace }
    reads[action].mockResolvedValue(acknowledgement)
    function Tasks() {
      const linearStatus = s((state) => state.linearStatus)
      const model = { ...fixture(s, items), linearStatus }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: existing fixture supplies all exercised selection fields; unrelated full-page services are absent.
      const selection = useTaskPageLinearListSelectionPrelude(model as never)
      return (
        <>
          <output data-testid="account-error">{selection.activeLinearIssueError}</output>
          <output data-testid="account-rows">
            {selection.displayedLinearIssues.map((row) => row.state.name).join(',')}
          </output>
        </>
      )
    }
    render(<Tasks />)
    expect(screen.getByTestId('account-error').textContent).toBe(message)
    expect(screen.getByTestId('account-rows').textContent).toBe('In Review')
    await act(async () => {
      const result =
        action === 'connect'
          ? await s.getState().connectLinear('fixture-token')
          : await s.getState().testLinearConnection('w')
      expect(result).toEqual(acknowledgement)
    })
    expect(screen.getByTestId('account-error').textContent).toBe('')
    expect(screen.getByTestId('account-rows').textContent).toBe('In Review')
    expect(reads.list).toHaveBeenCalledTimes(1)
    expect(workspace).not.toHaveProperty('credentialRevision')
  }
)

describe('Linear refresh failure', () => {
  it.each(['list', 'search'] as const)(
    '%s shows failure while retaining rows, then clears it on successful retry',
    async (kind) => {
      const s = store()
      const query = kind === 'search' ? 'DAT-124' : ''
      const runtime = kind === 'search' ? reads.search : reads.list
      runtime.mockResolvedValue(response(kind, 'In Review'))
      await read(s, kind)
      runtime.mockRejectedValueOnce(new Error('raw provider private diagnostic'))
      const hook = loadingHook(s, query)
      await waitFor(() =>
        expect(hook.result.current.error).toBe('Unable to load Linear issues. Try again.')
      )
      expect(hook.result.current.rows[0].state.name).toBe('In Review')
      const table = () => {
        const model = {
          selectedLinearWorkspaceId: 'w',
          linearTaskSourceContext: null,
          selectedLinearIssueId: null,
          openLinearDetailPage: vi.fn(),
          linearIssueAttachmentIndex: new Map(),
          effectiveLinearDisplayProperties: new Set(['state']),
          linearIssueGridStyle: {},
          linearIssueListRows: hook.result.current.displayed.map((issue) => ({
            type: 'issue',
            issue
          })),
          handleOpenOrUseLinearItem: vi.fn()
        }
        // SAFETY: this is every input read by the actual Tasks table; loader and selection above are production.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every rendered Tasks table input is supplied; unrelated page actions are not exercised.
        const tableModel = model as unknown as TaskPageComposerActionsModel
        return (
          <TooltipProvider>
            <TaskPageLinearIssueTable model={tableModel} />
          </TooltipProvider>
        )
      }
      const visible = render(table())
      expect(
        screen.getAllByRole('button', { name: /Change Linear state from In Review/ })
      ).toHaveLength(2)
      runtime.mockResolvedValue(response(kind, 'Done'))
      hook.rerender({ nonce: 1 })
      await waitFor(() => expect(hook.result.current.rows[0].state.name).toBe('Done'))
      expect(hook.result.current.error).toBeNull()
      visible.rerender(table())
      expect(screen.getAllByRole('button', { name: /Change Linear state from Done/ })).toHaveLength(
        2
      )
    }
  )
})

it('keeps a filtered status-cell success through invalidation and rolls back a later failed edit', async () => {
  const s = store()
  s.setState({ recordFeatureInteraction: vi.fn() })
  reads.list.mockResolvedValue({ items: [task()] })
  const filter = { stateIds: ['review'], priorities: [], assignee: null, labelIds: [] }
  const hook = loadingHook(s, '', { linearAttributeFilter: filter })
  await waitFor(() => expect(reads.list).toHaveBeenCalled())
  const pending = deferred<{ ok: boolean }>()
  reads.update.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ok: false })
  const cell = render(<LinearStateCell issue={task()} />)
  fireEvent.click(screen.getByRole('button', { name: /Change Linear state from/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(hook.result.current.rows[0].state.name).toBe('Done'))
  reads.list.mockResolvedValue({ items: [task('Done')] })
  await act(async () => {
    pending.resolve({ ok: true })
    await pending.promise
  })
  expect(reads.list).toHaveBeenCalledTimes(2)
  expect(hook.result.current.rows[0].state.name).toBe('Done')
  // A separate failed edit starts from the last provider-confirmed row.
  cell.unmount()
  reads.list.mockResolvedValue({ items: [task()] })
  await act(async () => {
    await s.getState().listLinearIssues({ ...listArgs, attributeFilter: filter }, { force: true })
  })
  render(<LinearStateCell issue={task()} />)
  fireEvent.click(screen.getByRole('button', { name: /Change Linear state from/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(hook.result.current.rows[0].state.name).toBe('In Review'))
  expect(reads.update).toHaveBeenCalledTimes(2)
})

it('retains ordered linked source provenance when two hosts return the same UUID', async () => {
  const s = store()
  const first = source('local'),
    second = source('runtime:other')
  const refs = [
    { identifier: 'DAT-124', workspaceId: 'w', sourceContext: first },
    { identifier: 'DAT-124', workspaceId: 'w', sourceContext: second }
  ]
  // Real detail actions create the requested source/identifier keys.
  reads.detail.mockResolvedValueOnce(task()).mockResolvedValueOnce(task('Done'))
  const base = {
    ...fixture(s, []),
    ...s.getState(),
    taskResumeApplied: true,
    taskSource: 'linear',
    linearMode: 'in-orca',
    linearConnected: true,
    linearRefreshNonce: 0,
    lastLinearRequestRef: { current: null },
    inOrcaLinkedLinearRefsRef: { current: refs },
    inOrcaLinkedLinearRefsSignature: 'two-hosts',
    setLinearLoading: vi.fn(),
    setLinearError: vi.fn(),
    setLinearIssuesHasMore: vi.fn()
  }
  const hook = renderHook(() => {
    const result = useLinearIssueResult<LinearIssue[]>(
      'two-hosts',
      [],
      getLinearSourceScope(defaultScopeSource(null))
    )
    // SAFETY: fixture supplies the linked loader fields.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    useTaskPageLinearInOrcaEffects({
      ...base,
      linearIssueResult: result,
      setLinearIssues: result.setData
    } as never)
    return result.data
  })
  await waitFor(() => expect(hook.result.current).toHaveLength(2))
  act(() =>
    s
      .getState()
      .patchLinearIssue('same-uuid', { state: task('Blocked').state }, { sourceContext: first })
  )
  expect(hook.result.current.map((item) => item.state.name)).toEqual(['Blocked', 'Done'])
  act(() =>
    s.getState().patchLinearIssue('same-uuid', { state: task().state }, { sourceContext: first })
  )
  expect(hook.result.current.map((item) => item.state.name)).toEqual(['In Review', 'Done'])
})

it('opens the fresh row on its origin source despite stale aliases and failed detail hydration', async () => {
  const s = store(),
    origin = source('runtime:origin'),
    foreign = source('local')
  s.setState({
    jiraIssueCache: {},
    jiraSearchCache: {},
    linearIssueCache: {
      [`${getTaskSourceCacheScope(origin)}::w::DAT-124`]: { data: task(), fetchedAt: 1 },
      [`${getTaskSourceCacheScope(foreign)}::w::same-uuid`]: { data: task(), fetchedAt: cacheTime }
    }
  })
  reads.detail.mockRejectedValue(new Error('raw detail failure'))
  const hook = renderHook(() => {
    // SAFETY: routing fixture only opens Linear; Jira and callbacks are inert.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const route = useTaskPageDetailRouting({
      pageData: { openLinearIssue: task('Done'), openLinearSourceContext: origin },
      linearTaskSourceContext: foreign,
      setDialogWorkItem: vi.fn(),
      openTaskPage: vi.fn()
    } as never)
    if (!route.linearDetailSourceContext) {
      throw new Error('Expected the routed detail source')
    }
    const detail = useLinearIssueWorkspaceDetail({
      issue: route.selectedLinearIssue ?? task(),
      providerSettings: route.linearDetailSourceContext,
      requestKey: 'origin:uuid'
    })
    return { route, detail }
  })
  await waitFor(() => expect(hook.result.current.detail.issueLoading).toBe(false))
  expect(hook.result.current.detail.displayed.state.name).toBe('Done')
  expect(reads.detail).toHaveBeenCalledWith(origin, 'same-uuid', 'w')
})

it.each(['full', 'partial'] as const)(
  'keeps failed-workspace rows after %s list failure and reports one sanitized error',
  async (failure) => {
    const s = store()
    reads.list.mockResolvedValueOnce({ items: [task()] })
    await read(s, 'list')
    reads.list.mockResolvedValue({
      items:
        failure === 'partial' ? [{ ...task('Done'), id: 'another', workspaceId: 'healthy' }] : [],
      errors: [{ workspaceId: 'w', type: 'network', message: 'secret provider diagnostic' }]
    })
    const hook = loadingHook(s)
    await waitFor(() => expect(hook.result.current.error).toBeTruthy())
    expect(hook.result.current.rows.map((row) => row.state.name)).toEqual(
      failure === 'partial' ? ['Done', 'In Review'] : ['In Review']
    )
    expect(hook.result.current.error).toBe('Unable to load Linear issues. Try again.')
  }
)

it.each(['project', 'custom-view'] as const)(
  '%s failure uses only its source-qualified smaller collection and retains the request error',
  async (view) => {
    const s = store(),
      origin = source('runtime:origin')
    const load = (limit: number, sourceContext: TaskSourceContext | null) =>
      view === 'project'
        ? s.getState().listLinearProjectIssues('p', 'w', limit, { force: true, sourceContext })
        : s.getState().listLinearCustomViewIssues('v', 'w', limit, { force: true, sourceContext })
    wire(view)
      .mockResolvedValueOnce({ items: [task('Foreign')] })
      .mockResolvedValueOnce({ items: [task()] })
    await load(12, null)
    await load(12, origin)
    wire(view).mockRejectedValueOnce(new Error('raw network details'))
    const result = await load(36, origin)
    assert(result !== null)
    expect(result.items[0].state.name).toBe('In Review')
    // The fallback error is not cached; selection must retain this request's error beside cached rows.
    const model = {
      ...fixture(s, result.items, view),
      linearProjectIssuesResult: result,
      linearCustomViewIssuesResult: result
    }
    // SAFETY: the fixture supplies the selection prelude fields.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const hook = renderHook(() => useTaskPageLinearListSelectionPrelude(model as never))
    expect(hook.result.current.activeLinearIssueError).toBe(
      'Unable to load Linear issues. Try again.'
    )
  }
)

it('keeps retained page two reachable after a failed refresh and a successful retry', async () => {
  const s = store()
  const rows = Array.from({ length: 72 }, (_, i) => ({
    ...task(),
    id: `id-${i + 1}`,
    identifier: `DAT-${i + 1}`
  }))
  reads.list.mockResolvedValue({ items: rows })
  await s.getState().listLinearIssues({ ...listArgs, limit: 72 }, { force: true })
  const noop = vi.fn()
  const base = {
    ...fixture(s, rows),
    ...s.getState(),
    linearIssueLimit: 72,
    linearOrderBy: 'identifier',
    taskSource: 'linear',
    linearConnected: true,
    taskResumeApplied: true,
    linearSearchInput: '',
    setTaskResumeState: noop,
    setAppliedLinearSearch: noop,
    setLinearIssueLimit: noop,
    setLinearIssueLoadingTargetPage: noop,
    setLinearIssuesHasMore: noop,
    setLinearLoading: noop,
    linearIssueFiltersByWorkspaceId: {},
    linearSearchPersistReadyRef: { current: false },
    linearViewPersistReadyRef: { current: false },
    linearAttributeFilterReadRef: { current: null },
    lastLinearRequestRef: { current: null },
    landingLinearRefreshKeysRef: { current: new Set<string>() }
  }
  function Pages() {
    const [nonce, refresh] = useState(0)
    const result = useLinearIssueResult(
      'pagination',
      rows,
      getLinearSourceScope(defaultScopeSource(null))
    )
    const { data: items, error, setData: setLinearIssues, setError: setLinearError } = result
    const [page, setLinearIssuePage] = useState(0)
    const model = {
      ...base,
      linearRefreshNonce: nonce,
      linearIssueResult: result,
      linearIssues: items,
      linearError: error,
      linearIssuePage: page,
      setLinearIssues,
      setLinearError,
      setLinearIssuePage
    }
    // SAFETY: fixture supplies the real list loader, selection and projection dependencies.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    useTaskPageLinearListEffects(model as never)
    // SAFETY: fixture supplies selection fields; persistence is disabled.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const selection = useTaskPageLinearListSelectionPrelude(model as never)
    // SAFETY: only pagination is rendered, so presentation-only model fields are unused.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const projection = useTaskPageLinearListProjectionPrelude(selection as never)
    return (
      <>
        <button onClick={() => refresh((n) => n + 1)}>Refresh</button>
        <output data-testid="read-error">{error}</output>
        <output data-testid="retained-count">{items.length}</output>
        <output data-testid="page-first">{projection.pagedLinearIssues[0]?.identifier}</output>
        {projection.showLinearIssuePagination ? (
          <PaginationBar
            currentPage={projection.visibleLinearIssuePage}
            totalPages={projection.linearIssueTotalPages}
            loadingTarget={null}
            onPageChange={projection.handleLinearIssuePageChange}
          />
        ) : null}
      </>
    )
  }
  render(<Pages />)
  await waitFor(() => expect(reads.list).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: 'Next page' })).toBeTruthy()
  reads.list.mockRejectedValueOnce(new Error('private network diagnostic'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() =>
    expect(screen.getByTestId('read-error').textContent).toBe(
      'Unable to load Linear issues. Try again.'
    )
  )
  expect(screen.getByTestId('retained-count').textContent).toBe('72')
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  expect(screen.getByTestId('page-first').textContent).toBe('DAT-37')
  fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
  expect(screen.getByTestId('page-first').textContent).toBe('DAT-1')
  expect(reads.list).toHaveBeenCalledTimes(3)
  reads.list.mockResolvedValue({ items: rows })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(screen.getByTestId('read-error').textContent).toBe(''))
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  expect(screen.getByTestId('page-first').textContent).toBe('DAT-37')
})

it('bounds partial-workspace retention at N/10N through the real list action', async () => {
  const operations: number[] = []
  for (const n of [20, 200]) {
    clearLinearRequestMaps()
    const s = store()
    let ids = 0
    const counted = (workspaceId: string) =>
      Array.from({ length: n }, (_, i) => ({
        ...task(),
        workspaceId,
        get id() {
          ids++
          return `id-${i}`
        }
      }))
    const cached = counted('w')
    const fresh = counted('healthy')
    reads.list.mockResolvedValueOnce({ items: cached })
    await read(s, 'list')
    reads.list.mockResolvedValueOnce({
      items: fresh,
      errors: [{ workspaceId: 'w', type: 'network', message: 'failed' }]
    })
    ids = 0
    const result = await read(s, 'list')
    operations.push(ids)
    expect(ids).toBeLessThanOrEqual(n * 4)
    expect(!Array.isArray(result) && result?.items.map((row) => row.workspaceId)).toEqual([
      ...Array(n).fill('healthy'),
      ...Array(n).fill('w')
    ])
    const success = { items: fresh }
    reads.list.mockResolvedValueOnce(success)
    expect(await read(s, 'list')).toBe(success)
  }
  expect(operations[1]).toBeLessThanOrEqual(operations[0] * 11)
  console.info('partial retention identity reads N20/N200', operations)
})

it.each([20, 200])(
  'isolates real list and linked consumers at N=%i; counts work separately from renders',
  async (n) => {
    const s = store()
    let ids = 0
    const rows = Array.from({ length: n }, (_, i) => ({
      ...task(),
      get id() {
        ids++
        return `DAT-${i}`
      },
      identifier: `DAT-${i}`
    }))
    reads.list.mockResolvedValue({ items: rows })
    const list = loadingHook(s)
    await waitFor(() => expect(list.result.current.rows).toHaveLength(n))
    const origin = source('local')
    const refs = rows.map((row) => ({
      identifier: row.identifier,
      workspaceId: 'w',
      sourceContext: origin
    }))
    const byId = new Map(rows.map((row) => [row.identifier, row]))
    reads.detail.mockImplementation((_source, id) => Promise.resolve(byId.get(id)))
    const base = {
      ...fixture(s, []),
      ...s.getState(),
      taskResumeApplied: true,
      taskSource: 'linear',
      linearMode: 'in-orca',
      linearConnected: true,
      linearRefreshNonce: 0,
      lastLinearRequestRef: { current: null },
      inOrcaLinkedLinearRefsRef: { current: refs },
      inOrcaLinkedLinearRefsSignature: `N${n}`,
      setLinearLoading: vi.fn(),
      setLinearError: vi.fn(),
      setLinearIssuesHasMore: vi.fn()
    }
    let renders = 0
    const linked = renderHook(() => {
      renders++
      const result = useLinearIssueResult<LinearIssue[]>(
        `N${n}`,
        [],
        getLinearSourceScope(defaultScopeSource(null))
      )
      // SAFETY: the fixture installs the actual linked hook's selected dependencies.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
      useTaskPageLinearInOrcaEffects({
        ...base,
        linearIssueResult: result,
        setLinearIssues: result.setData
      } as never)
      return result.data
    })
    await waitFor(() => expect(linked.result.current).toHaveLength(n))
    expect(renders).toBeLessThanOrEqual(3)
    const before = renders
    const listRenders = list.result.current.renders
    const listRows = list.result.current.rows
    ids = 0
    act(() => s.setState({ linearTeamCache: {} }))
    expect(renders).toBe(before)
    expect(list.result.current.renders).toBe(listRenders)
    expect(ids).toBe(0)
    act(() =>
      s
        .getState()
        .patchLinearIssue(
          'DAT-0',
          { state: task('Foreign').state },
          { sourceContext: source('runtime:foreign') }
        )
    )
    expect(renders).toBe(before)
    expect(list.result.current.rows).toBe(listRows)
    expect(list.result.current.renders).toBe(listRenders)
    expect(ids).toBe(0)
    act(() =>
      s
        .getState()
        .patchLinearIssue('DAT-0', { state: task('Done').state }, { sourceContext: origin })
    )
    const patchOperations = ids
    expect(patchOperations).toBeLessThanOrEqual(n * 5)
    expect(renders).toBeGreaterThan(before)
    expect(linked.result.current[0].state.name).toBe('Done')
    expect(list.result.current.rows).toBe(listRows)
    ids = 0
    act(() =>
      s.getState().patchLinearIssue('DAT-0', { state: task().state }, { sourceContext: origin })
    )
    expect(ids).toBeLessThanOrEqual(n * 5)
    expect(linked.result.current[0].state.name).toBe('In Review')
    act(() => s.getState().patchLinearIssue('DAT-0', { state: task('Done').state }))
    expect(list.result.current.rows[0].state.name).toBe('Done')
    expect(list.result.current.renders).toBeGreaterThan(listRenders)
    const patchedRenders = list.result.current.renders
    act(() => s.getState().patchLinearIssue('DAT-0', { state: task().state }))
    expect(list.result.current.rows[0].state.name).toBe('In Review')
    expect(list.result.current.renders).toBeGreaterThan(patchedRenders)
    console.info('linked identity reads N', n, patchOperations)
  }
)

it.each([20, 200])('bounds real write-edge and read reconciliation work at Q=P=W=%i', async (n) => {
  const s = store()
  let workspaceKeys = 0,
    candidates = 0,
    foreignScopes = 0,
    foreignCandidates = 0
  const workspaces = Array.from({ length: n }, (_, i) => ({
    get id() {
      workspaceKeys++
      return `w${i}`
    },
    name: `Workspace ${i}`
  }))
  // SAFETY: only credential IDs/name and absent optional organization metadata are consumed.
  s.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'w0', workspaces } as never
  })
  const rows = Array.from({ length: n }, (_, i) => ({
    ...task(),
    id: `U${i}`,
    workspaceId: `w${i}`
  }))
  const pending = rows.map(() => deferred<{ ok: boolean }>())
  const saves = rows.map((row, i) =>
    writeLinearIssue(row, { priority: 1 }, defaultScopeSource(null), () => pending[i].promise)
  )
  const owners = pendingLinearIssueWrites.get(
    getLinearSourceScope(defaultScopeSource(null)).contextKey
  )!
  for (const owner of owners.values()) {
    Object.defineProperty(owner, 'organizationId', {
      get() {
        candidates++
        return undefined
      }
    })
  }
  const transport = deferred<LinearIssue[]>()
  reads.search.mockReturnValue(transport.promise)
  const leases = rows.map((_, i) => s.getState().searchLinearIssues(`query${i}`, n).acquire())
  expect(reads.search).toHaveBeenCalledTimes(n)
  const foreign = getLinearSourceScope(source('runtime:foreign'))
  const foreignPending = rows.map(() => deferred<{ ok: boolean }>())
  const foreignSaves = rows.map((row, i) =>
    writeLinearIssue(
      row,
      { priority: 3 },
      source('runtime:foreign'),
      () => foreignPending[i].promise
    )
  )
  for (const owner of pendingLinearIssueWrites.get(foreign.contextKey)!.values()) {
    Object.defineProperty(owner, 'organizationId', {
      get() {
        foreignCandidates++
        return undefined
      }
    })
  }
  const foreignKey = foreign.contextKey
  Object.defineProperty(foreign, 'contextKey', {
    get() {
      foreignScopes++
      return foreignKey
    }
  })
  reads.detail.mockReturnValue(new Promise(() => {}))
  const foreignLeases = rows.map((row) =>
    s.getState().fetchLinearIssue(row.id, row.workspaceId, { scope: foreign }).acquire()
  )
  workspaceKeys = 0
  candidates = 0
  foreignScopes = 0
  transport.resolve(rows)
  await Promise.all(leases.map((lease) => lease.waitForCurrentTerminal()))
  const reconciliation = { workspaceKeys, candidates }
  expect(workspaceKeys).toBe(0)
  expect(candidates).toBeLessThanOrEqual(n * (n + 2))
  expect(leases.every((lease) => lease.currentView().data?.[0].priority === 1)).toBe(true)
  candidates = 0
  workspaceKeys = 0
  foreignScopes = 0
  // Fresh cached observations use the same reconciliation while real writes remain pending.
  leases.forEach((lease, i) => {
    lease.release()
    leases[i] = s.getState().searchLinearIssues(`query${i}`, n).acquire()
  })
  expect(reads.search).toHaveBeenCalledTimes(n)
  expect(workspaceKeys).toBeLessThanOrEqual(n * n)
  expect(candidates).toBeLessThanOrEqual(n * (n + 2))
  expect(foreignScopes).toBe(0)
  expect(foreignCandidates).toBe(0)
  expect(leases.every((lease) => lease.currentView().data?.[0].priority === 1)).toBe(true)
  candidates = 0
  workspaceKeys = 0
  foreignScopes = 0
  const edit = deferred<{ ok: boolean }>()
  const mutate = vi.fn(() => edit.promise)
  const saving = writeLinearIssue(rows[0], { priority: 4 }, defaultScopeSource(null), mutate)
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(leases.every((lease) => lease.currentView().data?.[0].priority === 4)).toBe(true)
  edit.resolve({ ok: false })
  await saving
  const edge = { workspaceKeys, candidates, foreignScopes }
  expect(workspaceKeys).toBeLessThanOrEqual(n)
  expect(candidates).toBeLessThanOrEqual(3 * n)
  expect(foreignScopes).toBe(0)
  expect(foreignCandidates).toBe(0)
  expect(reads.search).toHaveBeenCalledTimes(n)
  expect(leases.every((lease) => lease.currentView().data?.[0].priority === 1)).toBe(true)
  reads.search.mockResolvedValue(rows.map((row) => ({ ...row, priority: 2, title: 'External' })))
  pending.forEach((operation) => operation.resolve({ ok: false }))
  await Promise.all(saves)
  await Promise.all(leases.map((lease) => lease.waitForCurrentTerminal()))
  expect(reads.search).toHaveBeenCalledTimes(2 * n)
  expect(leases.every((lease) => lease.currentView().data?.[0].priority === 2)).toBe(true)
  leases.forEach((lease) => lease.release())
  foreignLeases.forEach((lease) => lease.release())
  foreignPending.forEach((operation) => operation.resolve({ ok: false }))
  await Promise.all(foreignSaves)
  expect(reads.detail).toHaveBeenCalledTimes(n)
  expect(pendingLinearIssueWrites.size).toBe(0)
  console.info('write/reconciliation operations', {
    n,
    reconciliation,
    edge,
    dispatches: reads.search.mock.calls.length
  })
})
