// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPageLinearViewStateModel } from './use-task-page-linear-view-state'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { JiraPriority } from '../../../shared/jira-types'
import { useTaskPageJiraListState } from './use-task-page-jira-list-state'

const transport = vi.hoisted(() => ({ priorities: vi.fn() }))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListPrioritiesForTarget: transport.priorities,
  jiraListPriorities: transport.priorities
}))

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

async function selectPriority(result: { current: ReturnType<typeof useTaskPageJiraListState> }) {
  await act(async () => result.current.setJiraOrderBy('priority'))
  await waitFor(() => expect(transport.priorities).toHaveBeenCalledTimes(1))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  transport.priorities.mockResolvedValue([])
})
afterEach(cleanup)

describe('Jira priority list source owner', () => {
  it('uses the captured account owner when the focused server differs', async () => {
    const model = fixture()
    const { result } = renderHook(() => useTaskPageJiraListState(model))
    await selectPriority(result)
    expect(transport.priorities).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'account' },
      'site-1'
    )
  })

  it('uses an explicit source before the captured account or focused server', async () => {
    const model = fixture('runtime:account', {
      kind: 'task-source',
      provider: 'jira',
      projectId: 'project',
      hostId: 'runtime:source'
    })
    const { result } = renderHook(() => useTaskPageJiraListState(model))
    await selectPriority(result)
    expect(transport.priorities).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'source' },
      'site-1'
    )
  })

  it.each(['local', 'ssh:example'] as const)(
    'uses the local IPC route for the %s account while another server is focused',
    async (hostId) => {
      const model = fixture(hostId)
      const { result } = renderHook(() => useTaskPageJiraListState(model))
      await selectPriority(result)
      expect(transport.priorities).toHaveBeenCalledWith({ kind: 'local' }, 'site-1')
    }
  )

  it.each(['account', 'source'] as const)(
    'rejects late priorities after the %s owner changes',
    async (kind) => {
      let resolveOld: (priorities: JiraPriority[]) => void = () => {}
      const oldPriorities = new Promise<JiraPriority[]>((resolve) => {
        resolveOld = resolve
      })
      const latest = [{ id: 'latest', name: 'Latest scheme' }]
      transport.priorities.mockReturnValueOnce(oldPriorities).mockResolvedValue(latest)
      const source: TaskSourceContext | null =
        kind === 'source'
          ? { kind: 'task-source', provider: 'jira', projectId: 'project', hostId: 'runtime:old' }
          : null
      const model = fixture('runtime:old', source)
      const { result, rerender } = renderHook(() => useTaskPageJiraListState(model))
      await selectPriority(result)
      await act(async () => {
        if (source) {
          model.jiraTaskSourceContext = { ...source, hostId: 'runtime:new' }
        } else {
          model.accountBackedTaskSourceHostId = 'runtime:new'
        }
        rerender()
      })
      await waitFor(() => expect(result.current.jiraPrioritiesBySite.get('site-1')).toEqual(latest))
      expect(transport.priorities).toHaveBeenLastCalledWith(
        { kind: 'environment', environmentId: 'new' },
        'site-1'
      )
      await act(async () => resolveOld([{ id: 'old', name: 'Old scheme' }]))
      expect(result.current.jiraPrioritiesBySite.get('site-1')).toEqual(latest)
    }
  )

  it.each(['account', 'source'] as const)(
    'hides an already loaded scheme during the next %s owner read',
    async (kind) => {
      const old = [{ id: 'old', name: 'Old scheme' }]
      const response = Promise.withResolvers<JiraPriority[]>()
      transport.priorities.mockResolvedValueOnce(old).mockReturnValueOnce(response.promise)
      const source: TaskSourceContext | null =
        kind === 'source'
          ? { kind: 'task-source', provider: 'jira', projectId: 'project', hostId: 'runtime:old' }
          : null
      const model = fixture('runtime:old', source)
      const { result, rerender } = renderHook(() => useTaskPageJiraListState(model))
      await selectPriority(result)
      await waitFor(() => expect(result.current.jiraPrioritiesBySite.get('site-1')).toEqual(old))
      await act(async () => {
        if (source) {
          model.jiraTaskSourceContext = { ...source, hostId: 'runtime:new' }
        } else {
          model.accountBackedTaskSourceHostId = 'runtime:new'
        }
        rerender()
      })
      expect(result.current.jiraPrioritiesBySite.size).toBe(0)
      await act(async () => response.resolve([{ id: 'new', name: 'New scheme' }]))
      expect(result.current.jiraPrioritiesBySite.get('site-1')).toEqual([
        { id: 'new', name: 'New scheme' }
      ])
    }
  )

  it.each(['account', 'source'] as const)(
    'fails closed for an unresolved %s owner',
    async (kind) => {
      const model = fixture(
        kind === 'account' ? 'runtime:unresolved-owner' : 'local',
        kind === 'source'
          ? {
              kind: 'task-source',
              provider: 'jira',
              projectId: 'project',
              hostId: 'runtime:unresolved-owner'
            }
          : null
      )
      const { result } = renderHook(() => useTaskPageJiraListState(model))
      await act(async () => result.current.setJiraOrderBy('priority'))
      expect(transport.priorities).not.toHaveBeenCalled()
      expect(result.current.jiraPrioritiesBySite.size).toBe(0)
    }
  )
})
