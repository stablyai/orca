import { useLinearIssueResult } from '@/hooks/linear-issue-committed-state'
// @vitest-environment happy-dom
import {
  reads,
  task,
  store,
  fixture,
  source
} from '../../src/renderer/src/components/task-page/linear/task-page-linear-refresh-test-fixtures'

import { defaultScopeSource } from '@/lib/default-creation-host'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'

import type { LinearIssue } from '../../src/shared/linear/issue-types'

import { useTaskPageLinearInOrcaEffects } from '../../src/renderer/src/components/task-page/linear/use-task-page-linear-in-orca-effects'
import { useTaskPageDetailRouting } from '../../src/renderer/src/components/task-page/use-task-page-detail-routing'
import { useLinearIssueWorkspaceDetail } from '../../src/renderer/src/components/linear-issue-workspace-detail-state'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

import { getTaskSourceCacheScope } from '../../src/shared/work-items/task-source-context'

const cacheTime = Date.parse('2026-01-01T00:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(cacheTime)
})
afterEach(() => vi.useRealTimers())

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
