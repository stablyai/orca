// @vitest-environment happy-dom
import {
  reads,
  task,
  store,
  listArgs,
  read,
  wire,
  response,
  loadingHook,
  source
} from './task-page-linear-refresh-test-fixtures'
import {
  pendingLinearIssueWrites,
  mapLinearIssueRead,
  registerLinearIssueConsumer
} from '@/store/slices/linear/linear-issue-publication'
import { writeLinearIssue } from '@/lib/linear-issue-write'
import { useLinearIssuePublication } from '@/hooks/useLinearIssuePublication'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { bumpProviderRuntimeSessionGeneration } from '@/lib/provider-runtime-context'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor, render, fireEvent, screen } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear-slice-test-harness'
import { inflightListRequests } from '../../../store/slices/linear/linear-slice-request-state'
import { LinearStateCell } from './task-page-linear-issue-model'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'

const cacheTime = Date.parse('2026-01-01T00:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(cacheTime)
})
afterEach(() => vi.useRealTimers())

it.each(
  (['list', 'search'] as const).flatMap((kind) =>
    ['F1', 'F2'].flatMap((timing) => [true, false].map((ok) => ({ kind, timing, ok })))
  )
)(
  '$kind $timing protects the intermediate edit and settles ok=$ok before accepting external truth',
  async ({ kind, timing, ok }) => {
    const s = store()
    s.setState({
      recordFeatureInteraction: vi.fn(),
      linearIssueCache: { 'w::same-uuid': { data: task(), fetchedAt: cacheTime } }
    })
    const runtime = wire(kind)
    runtime.mockResolvedValueOnce(response(kind, 'In Review'))
    await read(s, kind)
    const old = deferred<ReturnType<typeof response>>()
    const during = deferred<ReturnType<typeof response>>()
    const replacement = deferred<ReturnType<typeof response>>()
    runtime.mockReturnValueOnce(old.promise)
    if (timing === 'F2') {
      runtime.mockReturnValueOnce(during.promise)
    }
    runtime.mockReturnValueOnce(replacement.promise)
    const hook = loadingHook(s, kind === 'search' ? 'DAT-124' : '', {})
    await waitFor(() => expect(runtime).toHaveBeenCalledTimes(2))
    const pending = deferred<{ ok: boolean }>()
    reads.update.mockReturnValue(pending.promise)
    render(<LinearStateCell issue={hook.result.current.displayed[0]} />)
    fireEvent.click(screen.getByRole('button', { name: /Change Linear state from/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(hook.result.current.displayed[0].state.name).toBe('Done')
    if (timing === 'F2') {
      hook.rerender({ nonce: 1 })
      await act(async () => {
        during.resolve(response(kind, 'In Review'))
        await during.promise
      })
      expect(hook.result.current.displayed[0].state.name).toBe('Done')
    }
    await act(async () => {
      pending.resolve({ ok })
      await pending.promise
    })
    expect(hook.result.current.displayed[0].state.name).toBe(ok ? 'Done' : 'In Review')
    await act(async () => {
      old.resolve(response(kind, 'In Review'))
      await old.promise
    })
    expect(hook.result.current.displayed[0].state.name).toBe(ok ? 'Done' : 'In Review')
    expect(runtime).toHaveBeenCalledTimes(timing === 'F1' ? 3 : 4)
    await act(async () => {
      replacement.resolve(response(kind, 'External'))
      await replacement.promise
    })
    expect(hook.result.current.displayed[0].state.name).toBe('External')
  }
)

it('runs cold retire → park → drain → one coalesced failed replacement; late transport cannot clear loading', async () => {
  const s = store()
  let rejectOld!: (error: Error) => void
  const old = new Promise<ReturnType<typeof response>>((_resolve, reject) => {
    rejectOld = reject
  })
  const during = deferred<ReturnType<typeof response>>()
  let rejectReplacement!: (error: Error) => void
  const replacement = new Promise<ReturnType<typeof response>>((_resolve, reject) => {
    rejectReplacement = reject
  })
  reads.list
    .mockReturnValueOnce(old)
    .mockReturnValueOnce(during.promise)
    .mockReturnValueOnce(replacement)
  const hook = loadingHook(s)
  expect(hook.result.current.loading).toBe(true)
  expect(hook.result.current.rows).toEqual([])
  const joined = Array.from({ length: 5 }, () => s.getState().listLinearIssues(listArgs).acquire())
  const oldView = joined[0].currentView()
  const mutation = deferred<{ ok: boolean }>()
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(
      task(),
      { state: task('Done').state },
      defaultScopeSource(null),
      () => mutation.promise
    )
  })
  expect(joined[0].commit(oldView, false, () => true)).toBe(false)
  hook.rerender({ nonce: 1 })
  await act(async () => {
    during.resolve({ items: [] })
    await during.promise
  })
  expect(hook.result.current.loading).toBe(true)
  expect(hook.result.current.error).toBeNull()
  expect(reads.list).toHaveBeenCalledTimes(2)
  await act(async () => {
    mutation.resolve({ ok: false })
    await saving
  })
  expect(reads.list).toHaveBeenCalledTimes(3)
  expect(hook.result.current.loading).toBe(true)
  await act(async () => {
    rejectOld(new Error('old raw failure'))
    await old.catch(() => {})
  })
  expect(hook.result.current.loading).toBe(true)
  expect(hook.result.current.error).toBeNull()
  await act(async () => {
    rejectReplacement(new Error('current private failure'))
    await replacement.catch(() => {})
  })
  expect(hook.result.current.loading).toBe(false)
  expect(hook.result.current.error).toBe('Unable to load Linear issues. Try again.')
  expect(reads.list).toHaveBeenCalledTimes(3)
  for (const lease of joined) {
    expect((await lease.waitForCurrentTerminal()).kind).toBe('error')
    lease.release()
  }
})

it('keeps only own-query warm omissions, accepts new membership, and releases protection at settlement', async () => {
  const s = store()
  const untouched = { ...task(), id: 'untouched', title: 'untouched' }
  reads.list.mockResolvedValueOnce({ items: [task(), untouched] })
  await read(s, 'list')
  const next = { ...task('Server'), id: 'new', title: 'new' }
  reads.list.mockResolvedValueOnce({ items: [next] })
  const pending = deferred<{ ok: boolean }>()
  const hook = loadingHook(s)
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(
      task(),
      { state: task('Done').state },
      defaultScopeSource(null),
      () => pending.promise
    )
  })
  // A force dispatched during the pending interval may add rows, but cannot remove this query's protected occurrence.
  reads.list.mockResolvedValueOnce({ items: [next] })
  hook.rerender({ nonce: 1 })
  await waitFor(() =>
    expect(hook.result.current.rows.map((row) => row.id)).toEqual(['same-uuid', 'new'])
  )
  expect(hook.result.current.rows[0].state.name).toBe('Done')
  reads.list.mockResolvedValueOnce({ items: [] })
  await act(async () => {
    pending.resolve({ ok: true })
    await saving
  })
  await waitFor(() => expect(hook.result.current.rows).toEqual([]))
})

it('does not revive a cold abandoned query on drain and never joins a foreign source or runtime', async () => {
  const s = store()
  const old = deferred<ReturnType<typeof response>>()
  reads.list.mockReturnValue(old.promise)
  const hook = loadingHook(s)
  const pending = deferred<{ ok: boolean }>()
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(
      task(),
      { priority: 1 },
      defaultScopeSource(null),
      () => pending.promise
    )
  })
  hook.unmount()
  reads.search.mockResolvedValue([task('Foreign')])
  const foreign = await s
    .getState()
    .searchLinearIssues('DAT-124', 36, { sourceContext: source('runtime:other') })
  expect(foreign?.[0].state.name).toBe('Foreign')
  await act(async () => {
    pending.resolve({ ok: true })
    await saving
    old.resolve({ items: [] })
    await old.promise
  })
  expect(reads.list).toHaveBeenCalledTimes(1)
  expect(s.getState().getCachedLinearIssues(listArgs)).toBeNull()
})

it('checks authority inside a delayed real loader updater after write settlement', async () => {
  const s = store()
  reads.list.mockResolvedValueOnce({ items: [task()] })
  await read(s, 'list')
  const replacement = deferred<{ items: LinearIssue[] }>()
  reads.list
    .mockResolvedValueOnce({ items: [task('Pre-edit')] })
    .mockReturnValueOnce(replacement.promise)
  const queued: VoidFunction[] = []
  const hook = loadingHook(s, '', {}, queued)
  await waitFor(() => expect(queued.length).toBeGreaterThan(1))
  const old = queued.splice(0)
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
    pending.resolve({ ok: true })
    await saving
  })
  act(() => {
    for (const update of old) {
      update()
    }
  })
  expect(hook.result.current.rows[0].state.name).toBe('In Review')
  act(() => {
    for (const update of queued.splice(0)) {
      update()
    }
  })
  expect(hook.result.current.rows[0].state.name).toBe('Done')
  await act(async () => {
    replacement.resolve({ items: [task('External')] })
    await replacement.promise
  })
  act(() => {
    for (const update of queued.splice(0)) {
      update()
    }
  })
  expect(hook.result.current.rows[0].state.name).toBe('External')
})

it('rejects a during-save loader updater consumed after failure, then accepts external truth', async () => {
  const s = store()
  s.setState({ recordFeatureInteraction: vi.fn() })
  reads.list.mockResolvedValue({ items: [task()] })
  await read(s, 'list')
  const queued: VoidFunction[] = []
  const hook = loadingHook(s, '', {}, queued)
  const flushRows = () => {
    act(() => {
      for (const update of queued.splice(0)) {
        update()
      }
    })
  }
  await waitFor(() => expect(reads.list).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  flushRows()
  const pending = deferred<{ ok: boolean }>()
  reads.update.mockReturnValueOnce(pending.promise)
  render(<LinearStateCell issue={hook.result.current.displayed[0]} />)
  fireEvent.click(screen.getByRole('button', { name: /Change Linear state from/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  flushRows()
  expect(hook.result.current.displayed[0].state.name).toBe('Done')

  const during = deferred<{ items: LinearIssue[] }>()
  const external = deferred<{ items: LinearIssue[] }>()
  reads.list.mockReturnValueOnce(during.promise).mockReturnValueOnce(external.promise)
  hook.rerender({ nonce: 1 })
  expect(reads.list).toHaveBeenCalledTimes(3)
  await act(async () => {
    during.resolve({ items: [task()] })
    await during.promise
  })
  expect(hook.result.current.loading).toBe(false)
  expect(pendingLinearIssueWrites.size).toBe(1)
  const duringSave = queued.splice(0)
  expect(duringSave.length).toBeGreaterThan(0)
  await act(async () => {
    pending.resolve({ ok: false })
    await pending.promise
  })
  flushRows()
  expect(hook.result.current.displayed[0].state.name).toBe('In Review')
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(reads.list).toHaveBeenCalledTimes(4)
  act(() => {
    for (const update of duringSave) {
      update()
    }
  })
  expect(hook.result.current.displayed.map((row) => row.state.name)).toEqual(['In Review'])
  expect(hook.result.current.error).toBeNull()
  expect(hook.result.current.loading).toBe(true)
  await act(async () => {
    external.resolve({ items: [task('External')] })
    await external.promise
  })
  flushRows()
  expect(hook.result.current.displayed.map((row) => row.state.name)).toEqual(['External'])
  expect(hook.result.current.error).toBeNull()
  expect(hook.result.current.loading).toBe(false)
  hook.unmount()
  expect(inflightListRequests.size).toBe(0)
  expect(pendingLinearIssueWrites.size).toBe(0)
})

it('keeps literal identifier lookup independent of a different entity and isolates source/default/runtime', async () => {
  const s = store()
  const pending = deferred<{ ok: boolean }>()
  const origin = source('local'),
    another = { ...origin, accountLabel: 'other' }
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(task(), { state: task('Done').state }, origin, () => pending.promise)
  })
  reads.detail.mockResolvedValue({ ...task('Other entity'), id: 'different-U' })
  const other = await s
    .getState()
    .fetchLinearIssue('DAT-124', 'w', { sourceContext: origin, force: true })
  expect(other?.state.name).toBe('Other entity')
  reads.detail.mockResolvedValue(task('Other source'))
  expect(
    (await s.getState().fetchLinearIssue(task().id, 'w', { sourceContext: another, force: true }))
      ?.state.name
  ).toBe('Other source')
  expect((await s.getState().fetchLinearIssue(task().id, 'w', { force: true }))?.state.name).toBe(
    'Other source'
  )
  const oldScope = getLinearSourceScope(origin)
  act(() => {
    bumpProviderRuntimeSessionGeneration()
  })
  expect(oldScope.isCurrentRuntime()).toBe(false)
  expect(
    (await s.getState().fetchLinearIssue(task().id, 'w', { sourceContext: origin, force: true }))
      ?.state.name
  ).toBe('Other source')
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  expect(
    s.getState().linearIssueCache[`${getTaskSourceCacheScope(origin)}::w::same-uuid`]?.data?.state
      .name
  ).toBe('Other source')
})

it('dispatches despite a broken local subscriber and clears thrown writers independently of mount', async () => {
  const s = store()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const registration = registerLinearIssueConsumer(
    getLinearSourceScope(defaultScopeSource(null)),
    task().id,
    () => {
      throw new Error('subscriber bug')
    }
  )
  const mutate = vi.fn(async () => {
    throw new Error('transport failure')
  })
  await act(async () => {
    await expect(
      writeLinearIssue(task(), { priority: 4 }, defaultScopeSource(null), mutate)
    ).rejects.toThrow('transport failure')
  })
  expect(mutate).toHaveBeenCalledTimes(1)
  registration.release()
  reads.detail.mockResolvedValue({ ...task('External'), priority: 2 })
  expect((await s.getState().fetchLinearIssue(task().id, 'w', { force: true }))?.priority).toBe(2)
  warn.mockRestore()
})

it.each([false, true])(
  'cold organization evidence excludes only proven unrelated entities (legacy=%s)',
  async (legacy) => {
    const s = store()
    s.setState({
      linearStatus: {
        connected: true,
        viewer: null,
        selectedWorkspaceId: 'w',
        workspaces: [
          {
            id: 'w',
            organizationId: 'org-w',
            organizationName: 'W',
            displayName: 'W',
            email: null
          },
          {
            id: 'L',
            organizationId: legacy ? 'L' : 'other-org',
            organizationName: 'L',
            displayName: 'L',
            email: null,
            ...(legacy ? { isLegacy: true as const } : {})
          }
        ]
      }
    })
    const pending = deferred<{ ok: boolean }>()
    const saving = writeLinearIssue(
      { ...task(), workspaceId: 'L' },
      { priority: 4 },
      defaultScopeSource(null),
      () => pending.promise
    )
    reads.list.mockResolvedValue({ items: [] })
    const lease = s
      .getState()
      .listLinearIssues(listArgs, { force: true, workspaceId: 'w' })
      .acquire()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(lease.currentView().kind).toBe(legacy ? 'loading' : 'data')
    await act(async () => {
      pending.resolve({ ok: false })
      await saving
    })
    expect((await lease.waitForCurrentTerminal()).kind).toBe('data')
    expect(reads.list).toHaveBeenCalledTimes(legacy ? 2 : 1)
    lease.release()
  }
)

it('compacts settled successors while one old writer is pending, then accepts external truth', async () => {
  const s = store()
  const pending = deferred<{ ok: boolean }>()
  const saving = writeLinearIssue(
    task(),
    { priority: 4 },
    defaultScopeSource(null),
    () => pending.promise
  )
  const local = renderHook(() => {
    return useLinearIssuePublication(task(), defaultScopeSource(null)).issue!
  })
  for (const priority of Array.from({ length: 30 }, (_, i) => i + 1)) {
    await act(async () => {
      await writeLinearIssue(task(), { priority }, defaultScopeSource(null), async () => ({
        ok: true
      }))
    })
    expect(local.result.current.priority).toBe(priority)
    const group = pendingLinearIssueWrites
      .get(getLinearSourceScope(defaultScopeSource(null)).contextKey)
      ?.get(task().id)
      ?.fields.get('priority')
    expect(group?.contributions).toHaveLength(2)
    expect(group?.contributions.filter((entry) => entry.operation)).toHaveLength(1)
  }
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  expect(local.result.current.priority).toBe(30)
  expect(
    pendingLinearIssueWrites.has(getLinearSourceScope(defaultScopeSource(null)).contextKey)
  ).toBe(false)
  reads.detail.mockResolvedValue({ ...task(), priority: 2 })
  expect((await s.getState().fetchLinearIssue(task().id, 'w', { force: true }))?.priority).toBe(2)
})

it('captured default runtime cannot seed or patch the focused foreign runtime cache', async () => {
  const s = store()
  const pending = deferred<{ ok: boolean }>()
  const saving = writeLinearIssue(
    task(),
    { state: task('Done').state },
    defaultScopeSource(null),
    () => pending.promise
  )
  // SAFETY: only activeRuntimeEnvironmentId is read by this captured-scope fixture.
  s.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    settings: { activeRuntimeEnvironmentId: 'remote' } as never,
    linearIssueCache: { 'w::same-uuid': { data: task('Remote'), fetchedAt: cacheTime } }
  })
  const remote = s.getState().fetchLinearIssue(task().id, 'w').acquire()
  expect(remote.currentView().data?.state.name).toBe('Remote')
  reads.detail.mockResolvedValue(task('Local observation'))
  const lease = s
    .getState()
    .fetchLinearIssue(task().id, 'w', {
      scope: getLinearSourceScope({ kind: 'local' }),
      force: true
    })
    .acquire()
  expect(lease.currentView().data).toBeNull()
  expect((await lease.waitForCurrentTerminal()).data?.state.name).toBe('Done')
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  expect(s.getState().linearIssueCache['w::same-uuid'].data?.state.name).toBe('Remote')
  expect(remote.currentView().kind).toBe('data')
  expect(remote.currentView().data?.state.name).toBe('Remote')
  remote.release()
  lease.release()
})

it('full disconnect detaches default and every explicit source, preserving another runtime and replacement owner', async () => {
  const s = store()
  const contexts = [
    defaultScopeSource(null),
    source('local'),
    { ...source('local'), accountLabel: 'second' },
    source('runtime:other')
  ]
  const pending = contexts.map(() => deferred<{ ok: boolean }>())
  const saves = contexts.map((context, i) =>
    writeLinearIssue(task(), { priority: 4 }, context, () => pending[i].promise)
  )
  await s.getState().disconnectLinear()
  const keys = contexts.map((context) => getLinearSourceScope(context).contextKey)
  expect(keys.map((key) => pendingLinearIssueWrites.has(key))).toEqual([false, false, false, true])
  expect((await s.getState().connectLinear('fixture-not-a-credential')).ok).toBe(true)
  reads.detail.mockResolvedValue({ ...task(), priority: 2 })
  const lease = s
    .getState()
    .fetchLinearIssue(task().id, 'w', { scope: getLinearSourceScope(contexts[1]), force: true })
    .acquire()
  expect((await lease.waitForCurrentTerminal()).data?.priority).toBe(2)
  const next = deferred<{ ok: boolean }>()
  const replacement = writeLinearIssue(
    { ...task(), priority: 2 },
    { priority: 3 },
    contexts[1],
    () => next.promise
  )
  await act(async () => {
    for (let i = 0; i < 3; i++) {
      pending[i].resolve({ ok: i === 2 })
    }
    await Promise.all(saves.slice(0, 3))
  })
  expect(pendingLinearIssueWrites.has(keys[1])).toBe(true)
  expect(pendingLinearIssueWrites.has(keys[3])).toBe(true)
  expect(lease.currentView().data?.priority).toBe(3)
  await act(async () => {
    next.resolve({ ok: false })
    pending[3].resolve({ ok: true })
    await Promise.all([replacement, saves[3]])
  })
  expect((await lease.waitForCurrentTerminal()).data?.priority).toBe(2)
  lease.release()
  expect(pendingLinearIssueWrites.size).toBe(0)
})

it('a shared read gives explicit-runtime consumers authority after default focus moves', async () => {
  const s = store(),
    pending = deferred<LinearIssue | null>()
  reads.detail.mockReturnValue(pending.promise)
  const focused = s.getState().fetchLinearIssue(task().id, 'w').acquire()
  const pinned = s
    .getState()
    .fetchLinearIssue(task().id, 'w', { scope: getLinearSourceScope({ kind: 'local' }) })
    .acquire()
  expect(reads.detail).toHaveBeenCalledTimes(1)
  // SAFETY: the fixture only reads the focused runtime selector from settings.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
  s.setState({ settings: { activeRuntimeEnvironmentId: 'elsewhere' } as never })
  await act(async () => {
    pending.resolve(task('Local'))
    await pending.promise
  })
  expect(focused.currentView().kind).toBe('abandoned')
  expect(pinned.currentView().data?.state.name).toBe('Local')
  focused.release()
  pinned.release()
})

it.each([false, true])(
  'a real pending write parks a cold null detail (cached=%s) only until its compatible actual drain',
  async (cached) => {
    const s = store()
    const pending = deferred<{ ok: boolean }>()
    if (cached) {
      reads.detail.mockResolvedValueOnce(null)
      expect(await s.getState().fetchLinearIssue('DAT-124', 'w')).toBeNull()
      reads.detail.mockClear()
    }
    const saving = writeLinearIssue(
      task(),
      { priority: 4 },
      defaultScopeSource(null),
      () => pending.promise
    )
    if (!cached) {
      reads.detail.mockResolvedValueOnce(null)
    }
    reads.detail.mockResolvedValueOnce(task('External'))
    const lease = s.getState().fetchLinearIssue('DAT-124', 'w').acquire()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(lease.currentView()).toMatchObject({ kind: 'loading', data: null })
    expect(reads.detail).toHaveBeenCalledTimes(cached ? 0 : 1)
    await act(async () => {
      pending.resolve({ ok: false })
      await saving
    })
    expect((await lease.waitForCurrentTerminal()).data?.state.name).toBe('External')
    expect(reads.detail).toHaveBeenCalledTimes(cached ? 1 : 2)
    expect(pendingLinearIssueWrites.size).toBe(0)
    lease.release()
  }
)

it('cached null is a terminal hit mapped to a settled preview, with fresh force and reacquisition', async () => {
  const s = store()
  s.setState({
    linearSearchCache: { 'w::search::cached-null::12': { data: null, fetchedAt: cacheTime } }
  })
  const map = vi.fn((data: LinearIssue[] | null) => ({ issue: data?.[0] ?? null, loading: false }))
  const read = s.getState().searchLinearIssues('cached-null', 12)
  const lease = mapLinearIssueRead(read, map).acquire()
  expect(lease.currentView()).toEqual({ kind: 'data', data: { issue: null, loading: false } })
  expect(map).toHaveBeenCalledExactlyOnceWith(null)
  expect(reads.search).not.toHaveBeenCalled()
  reads.search.mockResolvedValueOnce([task('Fresh')])
  s.getState().searchLinearIssues('cached-null', 12, { force: true })
  expect(lease.currentView().kind).toBe('loading')
  expect((await lease.waitForCurrentTerminal()).data?.issue?.state.name).toBe('Fresh')
  expect(reads.search).toHaveBeenCalledTimes(1)
  lease.release()
  const reacquired = s.getState().searchLinearIssues('cached-null', 12).acquire()
  expect(reacquired.currentView()).toMatchObject({
    kind: 'data',
    data: [{ state: { name: 'Fresh' } }]
  })
  expect(reads.search).toHaveBeenCalledTimes(1)
  reacquired.release()
  reads.search.mockResolvedValueOnce([])
  expect(await s.getState().searchLinearIssues('miss', 12)).toEqual([])
  expect(reads.search).toHaveBeenCalledTimes(2)
  expect(pendingLinearIssueWrites.size).toBe(0)
})
