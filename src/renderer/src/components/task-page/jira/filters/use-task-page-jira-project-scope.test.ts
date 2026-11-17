// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { JiraProject } from '../../../../../../shared/jira/jira-types'
import { useTaskPageJiraProjectScope } from './use-task-page-jira-project-scope'

const defaultProject = { id: '10', key: 'DEF', name: 'Default', siteId: 'site-a' }
const pickedProject = { id: '20', key: 'PICK', name: 'Picked', siteId: 'site-a' }

// Picks live in session memory, so each test uses its own repo scope.
function makeRepo(id: string): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    defaultJiraProject: defaultProject
  }
}

function renderScope(
  repo: Repo,
  selectedRepos: readonly Repo[] = [repo],
  projects: readonly JiraProject[] = [defaultProject, pickedProject]
) {
  return renderHook(
    ({ loadedProjects }) =>
      useTaskPageJiraProjectScope(
        [repo],
        selectedRepos,
        undefined,
        'local',
        'site-a',
        loadedProjects,
        false
      ),
    { initialProps: { loadedProjects: projects } }
  )
}

describe('useTaskPageJiraProjectScope', () => {
  it('keeps a picked project, including All projects, after the Tasks page remounts', () => {
    const repo = makeRepo('repo-remount')
    const first = renderScope(repo)
    expect(first.result.current.jiraProjectFilter).toEqual(defaultProject)
    act(() => first.result.current.setJiraProjectFilter(pickedProject))
    first.unmount()
    expect(renderScope(repo).result.current.jiraProjectFilter).toEqual(pickedProject)

    const second = renderScope(repo)
    act(() => second.result.current.setJiraProjectFilter(null))
    second.unmount()
    expect(renderScope(repo).result.current.jiraProjectFilter).toBeNull()
  })

  it('scopes the picked project to the repo selection it was made in', () => {
    const repo = makeRepo('repo-selection')
    const scoped = renderScope(repo)
    act(() => scoped.result.current.setJiraProjectFilter(pickedProject))
    scoped.unmount()
    expect(renderScope(repo, []).result.current.jiraProjectFilter).toBeNull()
    expect(renderScope(repo).result.current.jiraProjectFilter).toEqual(pickedProject)
  })

  it('drops the picked project once the repo default changes in Settings', () => {
    const repo = makeRepo('repo-default-change')
    const scoped = renderScope(repo)
    act(() => scoped.result.current.setJiraProjectFilter(pickedProject))
    scoped.unmount()
    const newDefault = { ...defaultProject, id: '30', key: 'NEW', name: 'New' }
    const changedRepo = { ...repo, defaultJiraProject: newDefault }
    const changed = renderScope(changedRepo, [changedRepo])
    expect(changed.result.current.jiraProjectFilter).toEqual(newDefault)
  })

  it('falls back to the default when the loaded projects no longer include the pick', () => {
    const repo = makeRepo('repo-missing-pick')
    const scoped = renderScope(repo)
    act(() => scoped.result.current.setJiraProjectFilter(pickedProject))
    scoped.unmount()

    const remounted = renderScope(repo, [repo], [])
    expect(remounted.result.current.jiraProjectFilter).toEqual(pickedProject)
    remounted.rerender({ loadedProjects: [defaultProject] })
    expect(remounted.result.current.jiraProjectFilter).toEqual(defaultProject)
  })
})
