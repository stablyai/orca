// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { normalizeTaskSourceContext } from '../../../../shared/task-source-context'
import { useJiraComposerProject } from './use-jira-composer-project'
vi.mock('../use-jira-project-inventory', () => ({
  useJiraProjectInventory: () => ({ projects: [], connected: true, error: null, loading: false })
}))
const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
const other = { ...project, id: '20', key: 'BRV', name: 'Bravo' }
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Alpha',
  badgeColor: '',
  addedAt: 0,
  defaultJiraProject: project
}
const source = normalizeTaskSourceContext({ provider: 'jira', projectId: 'repo', hostId: 'local' })
afterEach(cleanup)
describe('Jira composer project defaults', () => {
  it('defaults from the repository and allows another project or All without changing the repository', () => {
    const { result } = renderHook(() => useJiraComposerProject(repo, source, true))
    expect(result.current.jiraProject).toEqual(project)
    act(() => result.current.setJiraProject(other))
    expect(result.current.jiraProject).toEqual(other)
    act(() => result.current.setJiraProject(null))
    expect(result.current.jiraProject).toBeNull()
    expect(repo.defaultJiraProject).toEqual(project)
  })
  it('uses a new repository default when the composer changes repositories', () => {
    const { result, rerender } = renderHook(
      ({ current }) => useJiraComposerProject(current, source, true),
      { initialProps: { current: repo } }
    )
    act(() => result.current.setJiraProject(null))
    rerender({ current: { ...repo, id: 'other', defaultJiraProject: other } })
    expect(result.current.jiraProject).toEqual(other)
  })
  it('resets All when switching between same-ID local and SSH repositories', () => {
    const { result, rerender } = renderHook(
      ({ current }) => useJiraComposerProject(current, source, true),
      { initialProps: { current: repo } }
    )
    act(() => result.current.setJiraProject(null))
    rerender({ current: { ...repo, executionHostId: 'ssh:target', defaultJiraProject: other } })
    expect(result.current.jiraProject).toEqual(other)
  })
  it('resets All when switching between distinct same-host repository locations', () => {
    const { result, rerender } = renderHook(
      ({ current }) => useJiraComposerProject(current, source, true),
      { initialProps: { current: repo } }
    )
    act(() => result.current.setJiraProject(null))
    rerender({ current: { ...repo, path: '/other-location', defaultJiraProject: other } })
    expect(result.current.jiraProject).toEqual(other)
  })
  it('keeps remote accounts separate and supports direct SSH with the existing local Jira account', () => {
    const remoteRepo: Repo = { ...repo, executionHostId: 'runtime:remote' }
    const { result, rerender } = renderHook(
      ({ current }) => useJiraComposerProject(current, source, true),
      { initialProps: { current: remoteRepo } }
    )
    expect(result.current.jiraProject).toBeNull()
    rerender({ current: { ...repo, executionHostId: 'ssh:target' } })
    expect(result.current.jiraProject).toEqual(project)
  })
})
