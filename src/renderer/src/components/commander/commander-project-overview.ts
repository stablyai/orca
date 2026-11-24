import { getProjectIdentityKey } from '../../../../shared/project/host-setup/project-host-setup-projection'
import {
  getRepoHostIdentity,
  getRepoHostIdentityForParts
} from '../../../../shared/repository/repo-host-identity'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { DashboardCard } from '../../../../shared/agent-status/presentation/dashboard-snapshot'

export type CommanderRepo = Pick<
  Repo,
  | 'id'
  | 'displayName'
  | 'upstream'
  | 'repoIcon'
  | 'gitRemoteIdentity'
  | 'connectionId'
  | 'executionHostId'
>
type CommanderCard = Pick<
  DashboardCard,
  'repoId' | 'repoName' | 'executionHostId' | 'bucket' | 'dotState'
>

export type CommanderActivity = 'all' | 'blocked' | 'waiting' | 'working'

export function cardHasCommanderActivity(
  card: CommanderCard,
  activity: CommanderActivity
): boolean {
  return (
    activity === 'all' ||
    (activity === 'working' ? card.bucket === 'working' : card.dotState === activity)
  )
}

export type ProjectActivity<T> = {
  id: string
  name: string
  cards: T[]
  blocked: number
  waiting: number
  working: number
}

export function projectCommanderAgents<T extends CommanderCard>(
  repos: readonly CommanderRepo[],
  cards: readonly T[]
) {
  const projects = new Map<string, ProjectActivity<T>>()
  const projectByRegistration = new Map<ReturnType<typeof getRepoHostIdentity>, string>()
  function project(id: string, name: string) {
    const existing = projects.get(id)
    if (existing) {
      return existing
    }
    const row: ProjectActivity<T> = { id, name, cards: [], blocked: 0, waiting: 0, working: 0 }
    projects.set(id, row)
    return row
  }
  for (const repo of repos) {
    const projectId = getProjectIdentityKey(repo)
    projectByRegistration.set(getRepoHostIdentity(repo), projectId)
    project(projectId, repo.displayName)
  }
  for (const card of cards) {
    const registration = getRepoHostIdentityForParts(card.repoId, card.executionHostId ?? 'local')
    const row = project(
      projectByRegistration.get(registration) ?? `repo:${card.repoId}`,
      card.repoName
    )
    row.cards.push(card)
    if (cardHasCommanderActivity(card, 'blocked')) {
      row.blocked++
    }
    if (card.dotState === 'waiting') {
      row.waiting++
    }
    if (cardHasCommanderActivity(card, 'working')) {
      row.working++
    }
  }
  return [...projects.values()].sort(
    (left, right) =>
      right.blocked - left.blocked ||
      right.waiting - left.waiting ||
      right.working - left.working ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id)
  )
}
