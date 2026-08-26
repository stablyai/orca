import { getRepoExecutionHostId } from './execution-host'
import type { Repo } from './repo-types'

type GetProjectId = (repo: Repo) => string

function compareProjectRegistrations(left: Repo, right: Repo): number {
  const leftAddedAt =
    Number.isFinite(left.addedAt) && left.addedAt !== 0 ? left.addedAt : Number.MAX_SAFE_INTEGER
  const rightAddedAt =
    Number.isFinite(right.addedAt) && right.addedAt !== 0 ? right.addedAt : Number.MAX_SAFE_INTEGER
  const timeDifference = leftAddedAt - rightAddedAt
  if (timeDifference !== 0) {
    return timeDifference
  }
  if (left.id === right.id) {
    return 0
  }
  return left.id < right.id ? -1 : 1
}

export function getSecondarySameHostCloneIds(
  repos: readonly Repo[],
  getProjectId: GetProjectId
): ReadonlySet<string> {
  const explicitReposByProjectHost = new Map<string, Repo[]>()
  for (const repo of repos) {
    if (!repo.projectHostSetupMethod) {
      continue
    }
    const key = `${getProjectId(repo)}\u0000${getRepoExecutionHostId(repo)}`
    const siblings = explicitReposByProjectHost.get(key)
    if (siblings) {
      siblings.push(repo)
    } else {
      explicitReposByProjectHost.set(key, [repo])
    }
  }

  const secondaryRepoIds = new Set<string>()
  for (const siblings of explicitReposByProjectHost.values()) {
    if (siblings.length < 2) {
      continue
    }
    const primary = siblings.reduce((left, right) =>
      compareProjectRegistrations(left, right) <= 0 ? left : right
    )
    for (const sibling of siblings) {
      if (sibling.id !== primary.id) {
        secondaryRepoIds.add(sibling.id)
      }
    }
  }
  return secondaryRepoIds
}
