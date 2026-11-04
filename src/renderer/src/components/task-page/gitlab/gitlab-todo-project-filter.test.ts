import { describe, expect, it } from 'vitest'
import type { GitLabTodo } from '../../../../../shared/gitlab-types'
import { filterGitLabTodosForRepos } from './gitlab-todo-project-filter'

function todo(id: number, projectPath: string): GitLabTodo {
  return {
    id,
    actionName: 'assigned',
    targetType: 'Issue',
    targetIid: id,
    targetTitle: `Todo ${id}`,
    targetUrl: `https://gitlab.example.com/${projectPath}/-/issues/${id}`,
    projectPath,
    authorUsername: '',
    authorAvatarUrl: '',
    updatedAt: '2026-10-23T00:00:00Z',
    state: 'pending'
  }
}

function repo(canonicalKey: string | null) {
  return {
    gitRemoteIdentity: canonicalKey
      ? { canonicalKey, remoteName: 'origin', remoteUrl: `https://${canonicalKey}.git` }
      : null
  }
}

describe('filterGitLabTodosForRepos', () => {
  const todos = [todo(1, 'Stack/App-A/api'), todo(2, 'stack/app-b/api'), todo(3, '')]

  it('keeps only todos from the selected repos projects', () => {
    expect(
      filterGitLabTodosForRepos(todos, [repo('gitlab.example.com/stack/app-a/api')]).map(
        (t) => t.id
      )
    ).toEqual([1])
  })

  it('keeps every todo when no selected repo has a resolved remote', () => {
    expect(filterGitLabTodosForRepos(todos, [repo(null)])).toBe(todos)
  })
})
