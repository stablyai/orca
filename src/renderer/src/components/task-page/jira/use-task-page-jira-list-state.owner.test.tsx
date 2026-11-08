// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPageLinearViewStateModel } from '../linear/use-task-page-linear-view-state'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

import { useTaskPageJiraListState } from './use-task-page-jira-list-state'

const transport = vi.hoisted(() => ({ priorities: vi.fn() }))
vi.mock('@/runtime/jira/runtime-jira-detail-client', () => ({
  jiraListPrioritiesForTarget: transport.priorities
}))
vi.mock('@/runtime/jira/runtime-jira-client', () => ({ jiraListPriorities: transport.priorities }))

function fixture(
  accountHostId: ExecutionHostId = 'runtime:account',
  sourceContext: TaskSourceContext | null = null
): TaskPageLinearViewStateModel {
  const model = {
    settings: { activeRuntimeEnvironmentId: 'focus' },
    accountBackedTaskSourceHostId: accountHostId,
    jiraConnected: true,
    selectedJiraSiteId: 'site-1',
    taskSource: 'jira',
    repos: [],
    selectedRepos: [],
    pageData: {},
    jiraTaskSourceContext: sourceContext
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This isolated hook reads only the listed pipeline fields.
  return model as unknown as TaskPageLinearViewStateModel
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  transport.priorities.mockResolvedValue([])
})
afterEach(cleanup)

describe('Jira Tasks view mode', () => {
  // Leaving Tasks unmounts the hook, so each case reopens it with a fresh render.
  function openTasks() {
    return renderHook(() => useTaskPageJiraListState(fixture())).result
  }

  it('reopens on the board after the view mode was switched', async () => {
    const first = openTasks()
    await act(async () => first.current.setJiraViewMode('board'))
    cleanup()
    expect(openTasks().current.jiraViewMode).toBe('board')
  })

  it('reopens on the list once the view mode is switched back', async () => {
    const first = openTasks()
    await act(async () => first.current.setJiraViewMode('board'))
    await act(async () => first.current.setJiraViewMode('list'))
    cleanup()
    expect(openTasks().current.jiraViewMode).toBe('list')
  })
})
