// @vitest-environment happy-dom
// @vitest-environment happy-dom
import { reads, task, store } from './task-page-linear-refresh-test-fixtures'
import '@/store/slices/linear/linear-issue-read'

import { writeLinearIssue } from '@/lib/work-items/linear/linear-issue-write'

import { defaultScopeSource } from '@/runtime/hosts/selection/default-creation-host'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { deferred } from '../../../../store/slices/linear/linear-slice-test-harness'

const cacheTime = Date.parse('2026-01-01T00:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(cacheTime)
})
afterEach(() => vi.useRealTimers())

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
