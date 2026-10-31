import {
  gitHubTaskFamilyOrigin,
  sameGitHubTaskObservation,
  type ObservedGitHubWorkItem,
  type GitHubTaskValueOrigin,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'

import type { TaskPageGitHubListFamily } from './task-page-github-work-item-registry-types'

import {
  applyTaskPageGitHubListOps,
  loginSetOfUsers,
  loginSetsEqual
} from './task-page-github-work-item-mutation-patches'

export type ListInput = {
  kind: 'full' | 'display'
  users: GitHubAssignableUser[]
  origin?: GitHubTaskValueOrigin
}
export type ListProtection =
  | { kind: 'whole'; expectedUsers: GitHubAssignableUser[]; confirmed: boolean }
  | {
      kind: 'addressed'
      facts: ReadonlyMap<string, { user?: GitHubAssignableUser; key: string; generation: number }>
    }
export type ListEntry = {
  sourceScope: string | null
  repoId: string
  itemId: string
  family: TaskPageGitHubListFamily
  itemType: GitHubWorkItem['type']
  observation?: GitHubTaskObservation
  lifetime: object
  base: ListInput
  protection: ListProtection
}
export type ListAddress = Pick<
  ListEntry,
  'sourceScope' | 'repoId' | 'itemId' | 'family' | 'observation'
> & { itemType?: GitHubWorkItem['type'] }
export type ListRetirement = {
  address: ListAddress
  fromLifetime: object
  restoration: ListInput
  toLifetime?: object
}
export type ListComposition = { address: ListAddress; retirement?: ListRetirement }
export type ListQueryTransition = {
  resolve?: (entries: readonly ListEntry[]) => ReadonlyMap<ListEntry, ListInput>
  publish: (plans: readonly ListComposition[]) => void
}
export function listInput(
  item: Pick<
    ObservedGitHubWorkItem,
    'assignees' | 'reviewRequests' | 'githubValueOrigins' | 'githubObservation'
  >,
  family: TaskPageGitHubListFamily,
  observation?: GitHubTaskObservation
): ListInput {
  const origin = gitHubTaskFamilyOrigin(item, family)
  return {
    kind:
      item[family] !== undefined &&
      origin?.kind === 'ordinary' &&
      origin.completeFamily &&
      sameGitHubTaskObservation(origin.owner, observation)
        ? 'full'
        : 'display',
    users: (item[family] ?? []).map((user) => ({ ...user })),
    origin
  }
}
export function completedListClaim(entry: ListEntry | undefined): ListProtection | undefined {
  return entry &&
    (entry.protection.kind === 'whole'
      ? entry.protection.confirmed
      : entry.protection.facts.size > 0)
    ? entry.protection
    : undefined
}
export function completedListInput(entry: ListEntry | undefined): ListInput | undefined {
  if (!entry || !completedListClaim(entry)) {
    return undefined
  }
  const users =
    entry.protection.kind === 'whole'
      ? entry.protection.expectedUsers.map((user) => ({ ...user }))
      : applyTaskPageGitHubListOps(
          entry.base.users,
          [...entry.protection.facts].map(([login, fact]) => ({
            family: entry.family,
            logins: [login],
            kind: fact.user ? 'add' : 'remove',
            users: fact.user ? [fact.user] : undefined
          }))
        )
  return {
    kind: 'display',
    users,
    origin: entry.base.origin ? { kind: 'ordinary', owner: entry.base.origin.owner } : undefined
  }
}
export function matchesListClaim(
  claim: ListProtection,
  users: readonly GitHubAssignableUser[]
): boolean {
  const logins = loginSetOfUsers(users)
  return claim.kind === 'whole'
    ? loginSetsEqual(loginSetOfUsers(claim.expectedUsers), logins)
    : [...claim.facts].every(([login, fact]) => logins.has(login) === !!fact.user)
}
