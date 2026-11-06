// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraProject } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { useJiraProjectInventory } from './use-jira-project-inventory'

const { status, projects } = vi.hoisted(() => ({ status: vi.fn(), projects: vi.fn() }))
vi.mock('@/runtime/runtime-jira-project-client', () => ({
  jiraStatusForTarget: status,
  jiraListProjectsForTarget: projects
}))
afterEach(cleanup)
beforeEach(() => {
  status.mockReset()
  projects.mockReset()
  status.mockResolvedValue({ connected: true })
})

describe('Jira project inventory ownership', () => {
  it('ignores a late result from the previous account host', async () => {
    const local: RuntimeClientTarget = { kind: 'local' }
    const remote: RuntimeClientTarget = { kind: 'environment', environmentId: 'owner' }
    const localProject = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'local-site' }
    const remoteProject = { ...localProject, siteId: 'remote-site' }
    let finishLocal: (value: JiraProject[]) => void = () => {
      throw new Error('Local request has not started')
    }
    projects.mockImplementation((source: RuntimeClientTarget) =>
      source === local
        ? new Promise<JiraProject[]>((resolve) => {
            finishLocal = resolve
          })
        : Promise.resolve([remoteProject])
    )
    const initialProps: { source: RuntimeClientTarget } = { source: local }
    const { result, rerender } = renderHook(({ source }) => useJiraProjectInventory(source, true), {
      initialProps
    })
    await waitFor(() => expect(projects).toHaveBeenCalledWith(local, 'all'))
    rerender({ source: remote })
    await waitFor(() => expect(result.current.projects).toEqual([remoteProject]))
    await act(async () => finishLocal([localProject]))
    expect(result.current.projects).toEqual([remoteProject])
  })
})
