import { splitGitRemoteKey } from '../../../../../shared/git-remote-identity'
import type { GitLabTodo } from '../../../../../shared/gitlab-types'
import type { Repo } from '../../../../../shared/repo-types'

/**
 * GitLab todos are user-scoped, so narrow them to the selected repos' projects.
 * Repos without a resolved remote can't be matched; if none resolve, keep every todo rather than show none.
 */
export function filterGitLabTodosForRepos(
  todos: readonly GitLabTodo[],
  repos: readonly Pick<Repo, 'gitRemoteIdentity'>[]
): readonly GitLabTodo[] {
  const projectPaths = new Set<string>()
  for (const repo of repos) {
    const parts = splitGitRemoteKey(repo.gitRemoteIdentity?.canonicalKey, (host) => host)
    if (parts) {
      projectPaths.add(parts.tail)
    }
  }
  if (projectPaths.size === 0) {
    return todos
  }
  return todos.filter((todo) => projectPaths.has(todo.projectPath.toLowerCase()))
}
