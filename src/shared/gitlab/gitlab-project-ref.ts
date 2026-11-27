import type { GitLabProjectRef } from './gitlab-types'

export function isSameGitLabProjectRef(
  a: GitLabProjectRef | null,
  b: GitLabProjectRef | null
): boolean {
  return a === b || (a?.host === b?.host && a?.path === b?.path)
}
