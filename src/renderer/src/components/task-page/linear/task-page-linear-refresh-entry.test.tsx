// @vitest-environment happy-dom
import {
  reads,
  task,
  store,
  source,
  deferredIssueSetters
} from './task-page-linear-refresh-test-fixtures'
import { pendingLinearIssueWrites } from '@/store/slices/linear/linear-issue-publication'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { writeLinearIssue } from '@/lib/linear-issue-write'
import { defaultScopeSource } from '@/lib/default-creation-host'
import LinearItemDrawer from '../../LinearItemDrawer'
import { useLinearIssueWorkspaceDetail } from '../../linear-issue-workspace-detail-state'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { expect, it, vi } from 'vitest'
import { act, renderHook, waitFor, render, screen } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear-slice-test-harness'

// The navigation snapshot predates the save; no second writer supplies a missing enrollment edge.
it.each(['workspace', 'drawer'] as const)(
  'late %s entry immediately derives only protected seed fields',
  async (entry) => {
    store()
    const pending = deferred<{ ok: boolean }>()
    const hydration = deferred<LinearIssue | null>()
    reads.detail.mockReturnValue(hydration.promise)
    const saving = writeLinearIssue(
      task('Other query'),
      { priority: 4 },
      defaultScopeSource(null),
      () => pending.promise
    )
    const seed = {
      ...task('Seed status'),
      title: 'Navigation seed',
      workspaceName: 'Seed workspace'
    }
    function Detail() {
      const detail = useLinearIssueWorkspaceDetail({
        issue: seed,
        providerSettings: defaultScopeSource(null),
        requestKey: 'same'
      })
      return (
        <output data-testid="late">
          {detail.displayed.state.name}:{detail.displayed.priority}:{detail.editState.priority}:
          {detail.displayed.workspaceName}
        </output>
      )
    }
    const mounted = render(
      entry === 'drawer' ? (
        <LinearItemDrawer issue={null} onUse={vi.fn()} onClose={vi.fn()} />
      ) : (
        <Detail />
      )
    )
    if (entry === 'drawer') {
      mounted.rerender(<LinearItemDrawer issue={seed} onUse={vi.fn()} onClose={vi.fn()} />)
    }
    expect(screen.getByTestId(entry === 'drawer' ? 'drawer' : 'late').textContent).toBe(
      entry === 'drawer' ? 'Seed status:4:' : 'Seed status:4:4:Seed workspace'
    )
    await act(async () => {
      hydration.resolve(null)
      await hydration.promise
    })
    expect(screen.getByTestId(entry === 'drawer' ? 'drawer' : 'late').textContent).toContain(':4:')
    await act(async () => {
      pending.resolve({ ok: false })
      await saving
    })
    expect(screen.getByTestId(entry === 'drawer' ? 'drawer' : 'late').textContent).toContain(':0:')
    mounted.unmount()
    expect(
      pendingLinearIssueWrites.has(getLinearSourceScope(defaultScopeSource(null)).contextKey)
    ).toBe(false)
  }
)

it('workspace hydration follows a full-source change without a remount or a successor edge', async () => {
  store()
  const A = source('local'),
    B = { ...A, accountLabel: 'B' }
  const old = deferred<LinearIssue | null>(),
    current = deferred<LinearIssue | null>()
  reads.detail
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise)
    .mockResolvedValue({ ...task('External'), priority: 2 })
  const detail = renderHook(
    ({ context }) =>
      useLinearIssueWorkspaceDetail({
        issue: task(),
        providerSettings: context,
        requestKey: 'unchanged-host-workspace-U'
      }),
    { initialProps: { context: A } }
  )
  detail.rerender({ context: B })
  expect(reads.detail).toHaveBeenCalledTimes(2)
  const pending = deferred<{ ok: boolean }>()
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(task(), { priority: 4 }, B, () => pending.promise)
  })
  await act(async () => {
    old.resolve({ ...task('Old A'), priority: 0 })
    await old.promise
  })
  expect(detail.result.current.displayed.priority).toBe(4)
  expect(detail.result.current.displayed.state.name).not.toBe('Old A')
  await act(async () => {
    current.resolve({ ...task('Current B'), priority: 1 })
    await current.promise
  })
  expect(detail.result.current.displayed.priority).toBe(4)
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  await waitFor(() => expect(detail.result.current.displayed.state.name).toBe('External'))
  expect(detail.result.current.displayed.priority).toBe(2)
  expect(detail.result.current.issueLoading).toBe(false)
})

it('queued initial detail setters cannot revoke settled intent or cross a full-source lifetime', async () => {
  store()
  const A = source('local'),
    B = { ...A, accountLabel: 'B' }
  const hydration = deferred<LinearIssue | null>()
  reads.detail.mockReturnValue(hydration.promise)
  const pending = deferred<{ ok: boolean }>()
  const saving = writeLinearIssue(task(), { priority: 4 }, A, () => pending.promise)
  deferredIssueSetters.enabled = true
  const detail = renderHook(
    ({ context }) =>
      useLinearIssueWorkspaceDetail({
        issue: task(),
        providerSettings: context,
        requestKey: 'same'
      }),
    { initialProps: { context: A } }
  )
  const initial = deferredIssueSetters.updates.splice(0)
  deferredIssueSetters.enabled = false
  await act(async () => {
    pending.resolve({ ok: true })
    await saving
  })
  expect(detail.result.current.displayed.priority).toBe(4)
  act(() => {
    initial.forEach((update) => update())
  })
  expect(detail.result.current.displayed.priority).toBe(4)
  deferredIssueSetters.enabled = true
  await act(async () => {
    hydration.resolve({ ...task('A observed'), priority: 1 })
    await hydration.promise
  })
  const oldRead = deferredIssueSetters.updates.splice(0)
  expect(oldRead.length).toBeGreaterThan(0)
  deferredIssueSetters.enabled = false
  reads.detail.mockReturnValue(new Promise(() => {}))
  detail.rerender({ context: B })
  const next = deferred<{ ok: boolean }>()
  let nextSave!: Promise<{ ok: boolean }>
  act(() => {
    nextSave = writeLinearIssue(task(), { priority: 3 }, B, () => next.promise)
  })
  act(() => {
    oldRead.forEach((update) => update())
  })
  expect(detail.result.current.displayed.priority).toBe(3)
  expect(detail.result.current.displayed.state.name).not.toBe('A observed')
  await act(async () => {
    next.resolve({ ok: false })
    await nextSave
  })
  detail.unmount()
  expect(pendingLinearIssueWrites.size).toBe(0)
})

it('actual runtime-status session loss and recovery reacquire hydration and finish loading', async () => {
  const s = store()
  const { createRuntimeStatusSlice } = await import('@/store/slices/runtime-status')
  // SAFETY: this fixture installs the production runtime slice over the same Zustand store.
  const runtime = createRuntimeStatusSlice(
    s.setState,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    s.getState as unknown as Parameters<typeof createRuntimeStatusSlice>[1]
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
  s.setState({ ...runtime, settings: { activeRuntimeEnvironmentId: 'remote' } as never })
  runtime.setRuntimeEnvironmentStatus(
    'remote',
    { status: null, checkedAt: 1 },
    { suppressDisconnectToast: true }
  )
  const old = deferred<LinearIssue | null>(),
    fresh = deferred<LinearIssue | null>()
  reads.detail.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const detail = renderHook(() =>
    useLinearIssueWorkspaceDetail({
      issue: task(),
      providerSettings: source('runtime:remote'),
      requestKey: 'same'
    })
  )
  act(() =>
    detail.result.current.handleCommentAdded({
      id: 'local',
      body: 'Draft comment',
      createdAt: 'today'
    })
  )
  await act(async () => {
    // SAFETY: the real transition inspects runtime identity/readiness only; no snapshot or transport is used.
    runtime.setRuntimeEnvironmentStatus(
      'remote',
      {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
        status: {
          runtimeId: 'new',
          graphStatus: 'ready',
          rendererGraphEpoch: 0,
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 3
        } as never,
        checkedAt: 2
      },
      { suppressDisconnectToast: true }
    )
  })
  expect(reads.detail).toHaveBeenCalledTimes(2)
  await act(async () => {
    old.resolve(task('Old session'))
    fresh.resolve(task('New session'))
    await Promise.all([old.promise, fresh.promise])
  })
  expect(detail.result.current.displayed.state.name).toBe('New session')
  expect(detail.result.current.issueLoading).toBe(false)
  expect(detail.result.current.comments.map((comment) => comment.id)).toContain('local')
  const pending = deferred<{ ok: boolean }>()
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(
      task(),
      { priority: 4 },
      source('runtime:remote'),
      () => pending.promise
    )
  })
  expect(reads.detail).toHaveBeenCalledTimes(2)
  detail.unmount()
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
})

it('local publication runtime subscription isolates unrelated store and foreign-source turns', async () => {
  const s = store()
  const { useLinearIssuePublication } = await import('@/hooks/useLinearIssuePublication')
  const renders = [0, 0]
  const mount = (index: number, context: ReturnType<typeof source>) =>
    renderHook(() => {
      renders[index]++
      return useLinearIssuePublication(task(), context).issue!
    })
  const local = mount(0, source('local')),
    foreign = mount(1, source('runtime:foreign'))
  const initial = [...renders]
  act(() => s.setState({ linearTeamCache: {} }))
  expect(renders).toEqual(initial)
  act(() =>
    s
      .getState()
      .patchLinearIssue(task().id, { priority: 2 }, { sourceContext: source('runtime:other') })
  )
  expect(renders).toEqual(initial)
  const pending = deferred<{ ok: boolean }>()
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(task(), { priority: 4 }, source('local'), () => pending.promise)
  })
  expect(local.result.current.priority).toBe(4)
  expect(renders[0]).toBeGreaterThan(initial[0])
  expect(renders[1]).toBe(initial[1])
  const patched = renders[0]
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  expect(local.result.current.priority).toBe(0)
  expect(renders[0]).toBeGreaterThan(patched)
  expect(renders[1]).toBe(initial[1])
  expect(foreign.result.current.priority).toBe(0)
})

it('drawer null-state enrollment survives its deferred initial setters and actual save settlement', async () => {
  store()
  reads.detail.mockReturnValue(new Promise(() => {}))
  const pending = deferred<{ ok: boolean }>()
  const saving = writeLinearIssue(
    task(),
    { priority: 4 },
    defaultScopeSource(null),
    () => pending.promise
  )
  const drawer = render(<LinearItemDrawer issue={null} onUse={vi.fn()} onClose={vi.fn()} />)
  deferredIssueSetters.enabled = true
  drawer.rerender(<LinearItemDrawer issue={task()} onUse={vi.fn()} onClose={vi.fn()} />)
  const initial = deferredIssueSetters.updates.splice(0)
  expect(initial.length).toBeGreaterThan(0)
  deferredIssueSetters.enabled = false
  await act(async () => {
    pending.resolve({ ok: true })
    await saving
  })
  expect(screen.getByTestId('drawer').textContent).toBe('In Review:4:')
  act(() => {
    initial.forEach((update) => update())
  })
  expect(screen.getByTestId('drawer').textContent).toBe('In Review:4:')
  drawer.unmount()
  act(() => {
    initial.forEach((update) => update())
  })
  expect(pendingLinearIssueWrites.size).toBe(0)
})

it.each(['probe', 'disconnect'] as const)(
  'foreign mounted hydration completes after local %s without another render edge',
  async (edge) => {
    const s = store()
    const foreign = source('runtime:foreign')
    const transport = deferred<LinearIssue | null>()
    reads.detail.mockReturnValue(transport.promise)
    const local = renderHook(() =>
      useLinearIssueWorkspaceDetail({
        issue: task(),
        providerSettings: defaultScopeSource(null),
        requestKey: 'local-U'
      })
    )
    const foreignKey = `${getLinearSourceScope(foreign).cachePrefix}::w::other`
    const foreignCache = { data: task('Foreign cache'), fetchedAt: 1 }
    s.setState({ linearIssueCache: { [foreignKey]: foreignCache } })
    const detail = renderHook(() =>
      useLinearIssueWorkspaceDetail({
        issue: task(),
        providerSettings: foreign,
        requestKey: 'foreign-U'
      })
    )
    expect(detail.result.current.issueLoading).toBe(true)
    await act(async () => {
      await (edge === 'probe'
        ? s.getState().testLinearConnection('w')
        : s.getState().disconnectLinear())
    })
    await act(async () => {
      transport.resolve(task('Foreign provider'))
      await transport.promise
    })
    expect(detail.result.current.displayed.state.name).toBe('Foreign provider')
    expect(detail.result.current.issueLoading).toBe(false)
    expect(reads.detail).toHaveBeenCalledTimes(2)
    expect(s.getState().linearIssueCache[foreignKey]).toBe(foreignCache)
    if (edge === 'disconnect') {
      expect(local.result.current.issueLoading).toBe(false)
      expect(local.result.current.displayed.state.name).toBe('In Review')
    } else {
      expect(local.result.current.displayed.state.name).toBe('Foreign provider')
      expect(local.result.current.issueLoading).toBe(false)
    }
    local.unmount()
    detail.unmount()
  }
)
