import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/types'

export type AutomationProjectGroup = {
  projectKey: string
  repo: Repo
  sources: Repo[]
}

export function getAutomationProjectGroups(
  repos: readonly Repo[],
  selectedRepoId: string
): AutomationProjectGroup[] {
  const groupsByProject = new Map<string, AutomationProjectGroup>()
  for (const repo of repos) {
    const projectKey = getProjectIdentityKey(repo)
    const current = groupsByProject.get(projectKey)
    if (!current) {
      groupsByProject.set(projectKey, { projectKey, repo, sources: [repo] })
      continue
    }
    current.sources.push(repo)
    if (compareAutomationProjectCandidate(repo, current.repo, selectedRepoId) < 0) {
      current.repo = repo
    }
  }
  return [...groupsByProject.values()].map((group) => ({
    ...group,
    sources: [...group.sources].sort(compareAutomationProjectSource)
  }))
}

export function getAutomationProjectGroupForRepo(
  groups: readonly AutomationProjectGroup[],
  repoId: string
): AutomationProjectGroup | null {
  return groups.find((group) => group.sources.some((source) => source.id === repoId)) ?? null
}

export function getAutomationProjectSelectedSource(
  group: AutomationProjectGroup,
  repoId: string
): Repo {
  return group.sources.find((source) => source.id === repoId) ?? group.repo
}

function compareAutomationProjectCandidate(a: Repo, b: Repo, selectedRepoId: string): number {
  const aSelected = a.id === selectedRepoId
  const bSelected = b.id === selectedRepoId
  if (aSelected !== bSelected) {
    return aSelected ? -1 : 1
  }
  return compareAutomationProjectSource(a, b)
}

function compareAutomationProjectSource(a: Repo, b: Repo): number {
  const aLocal = getRepoExecutionHostId(a) === LOCAL_EXECUTION_HOST_ID
  const bLocal = getRepoExecutionHostId(b) === LOCAL_EXECUTION_HOST_ID
  if (aLocal !== bLocal) {
    return aLocal ? -1 : 1
  }
  return (a.addedAt ?? 0) - (b.addedAt ?? 0) || a.id.localeCompare(b.id)
}
