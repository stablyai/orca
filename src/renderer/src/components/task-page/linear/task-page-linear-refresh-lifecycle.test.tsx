// @vitest-environment happy-dom
import {
  reads,
  task,
  store,
  read,
  loadingHook,
  source
} from './task-page-linear-refresh-test-fixtures'
import {
  pendingLinearIssueWrites,
  registerLinearIssueConsumer
} from '@/store/slices/linear/linear-issue-publication'
import { writeLinearIssue } from '@/lib/work-items/linear/linear-issue-write'

import { defaultScopeSource } from '@/lib/default-creation-host'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'

import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear/linear-slice-test-harness'

const cacheTime = Date.parse('2026-01-01T00:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(cacheTime)
})
afterEach(() => vi.useRealTimers())

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
