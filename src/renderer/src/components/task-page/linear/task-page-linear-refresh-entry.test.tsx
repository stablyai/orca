// @vitest-environment happy-dom
import { reads, task, store, source } from './task-page-linear-refresh-test-fixtures'

import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { writeLinearIssue } from '@/lib/work-items/linear/linear-issue-write'
import { defaultScopeSource } from '@/runtime/hosts/selection/default-creation-host'

import { useLinearIssueWorkspaceDetail } from '../../linear-issue-workspace-detail-state'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear/linear-slice-test-harness'

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

it('actual runtime-status session loss and recovery reacquire hydration and finish loading', async () => {
  const s = store()
  const { createRuntimeStatusSlice } =
    await import('@/store/slices/runtime-status/create-runtime-status-slice')
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
