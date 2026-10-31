import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'
import type { GitHubTaskObservation } from '@/lib/github-task-observation'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import type { HostIdentityFence } from '../host-catalog-fencing'
import { applyTaskChange, type TaskChange, type TaskFacts } from './task-change'

/** The shared task record's shape and the pure rules every layer of the record cache uses. */
/** One account/source binding's identity: a fresh token per incarnation, compared by reference (A→B→A gets a new one). */
export type BindingIncarnation = { readonly kind: 'task-binding-incarnation' }
export type TaskBinding = { observation: GitHubTaskObservation; incarnation: BindingIncarnation }
export type AcceptedTask = {
  binding: TaskBinding
  /** Addresses the issue (id, repo, URL); its facts are never projected or accepted. */
  address: GitHubWorkItem
  /** Only an accepted, current, owned provider reading sets the base. */
  base?: GitHubWorkItem
  visible?: GitHubWorkItem
  /** Before a base: the coalesced successful edits no accepted reading has covered yet. */
  confirmed?: TaskChange
  pending: Map<object, TaskChange>
  revision: number
  readOrder: number
  needsRead: boolean
  read?: { revision: number; light: boolean; promise: Promise<boolean> }
  /** When its last owned read came back unusable: it waits for an external delivery, oldest first. */
  failedAt?: number
  /** Replaced whenever what the record projects may have changed. */
  stamp: object
}
// Project rows carry the first 10 labels and 5 assignees (project-view-query-fragments.ts).
export const PROJECT_LABEL_LIMIT = 10
export const PROJECT_ASSIGNEE_LIMIT = 5
export const version = (item: GitHubWorkItem | undefined) =>
  item ? Date.parse(item.updatedAt) : Number.NaN
export const login = (value: string) => value.toLowerCase()
const sorted = (values: readonly string[]) => [...values].sort().join('\0')
const logins = (item: TaskFacts) => item.assignees?.map((user) => login(user.login))
export const bindingKey = (repo: Repo) => `${getRepoExecutionHostId(repo)}\0${repo.id}`
/** The connection a fence was captured on; a reconnect or upgrade makes server support unknown again. */
export const connection = ({
  pairingRevision,
  runtimeConnectionGeneration,
  sshTargetConnectionGeneration
}: HostIdentityFence) =>
  `${pairingRevision}\0${runtimeConnectionGeneration}\0${sshTargetConnectionGeneration}`
export const sources = (record: AcceptedTask) =>
  record.binding.observation.associations.map(({ source }) => source)

/** Records own state, label-name and assignee-login membership; profiles and presentation follow the latest row. */
export function sameFacts(a: TaskFacts, b: TaskFacts, unknownAssigneesMatch = true): boolean {
  const left = logins(a),
    right = logins(b)
  return (
    a.title === b.title &&
    a.state === b.state &&
    sorted(a.labels) === sorted(b.labels) &&
    (left && right ? sorted(left) === sorted(right) : unknownAssigneesMatch || left === right)
  )
}
export function facts(item: GitHubWorkItem): Partial<GitHubWorkItem> {
  const { title, state, labels, assignees } = item
  return { title, state, labels, ...(assignees === undefined ? {} : { assignees }) }
}
export function withFacts(row: GitHubWorkItem, visible: GitHubWorkItem): GitHubWorkItem {
  const users = new Map(row.assignees?.map((user) => [login(user.login), user]))
  return {
    ...row,
    ...facts(visible),
    ...(visible.assignees === undefined
      ? {}
      : { assignees: visible.assignees.map((user) => users.get(login(user.login)) ?? user) }),
    ...(version(visible) > version(row) ? { updatedAt: visible.updatedAt } : {})
  }
}
/** A value plus the record's unverified and pending changes, in order. */
export function contribute<T extends TaskFacts>(value: T, record: AcceptedTask): T {
  let next = applyTaskChange(value, record.confirmed)
  for (const change of record.pending.values()) {
    next = applyTaskChange(next, change)
  }
  return next
}
/** Panel rule: an ISSUE row with a concrete URL whose repository and number agree on the board's host. */
export function projectIssueLink(row: GitHubProjectRow, host: string | undefined) {
  const link = row.content.url ? parseGitHubIssueOrPRLink(row.content.url) : null
  const [owner, repo] = row.content.repository?.split('/') ?? []
  return row.itemType === 'ISSUE' &&
    link?.type === 'issue' &&
    link.number === row.content.number &&
    owner &&
    repo &&
    githubRepoIdentityKey(link.slug) === githubRepoIdentityKey({ owner, repo, host })
    ? link
    : null
}
/** A board row's own (possibly truncated) facts, so pending changes apply to what it shows. */
export function projectRowFacts(row: GitHubProjectRow): TaskFacts {
  return {
    title: row.content.title,
    state: row.content.state === 'CLOSED' ? 'closed' : 'open',
    labels: row.content.labels.map((label) => label.name),
    assignees: row.content.assignees.map((user) => ({
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl ?? ''
    }))
  }
}
/** A full-length Project list may be truncated, so only a name it carries that the record lacks conflicts. */
export function projectListConflicts(partial: string[], full: string[], limit: number) {
  const known = new Set(full)
  return (
    partial.some((name) => !known.has(name)) ||
    (partial.length < limit && partial.length !== known.size)
  )
}
export function projectList(
  partial: string[],
  full: string[],
  limit: number,
  norm = (v: string) => v
) {
  const has = (list: string[], value: string) => list.some((entry) => norm(entry) === norm(value))
  const kept = partial.filter((name) => has(full, name))
  return partial.length < limit ? [...kept, ...full.filter((name) => !has(partial, name))] : kept
}
export function newestFirst(a: AcceptedTask, b: AcceptedTask) {
  if (
    b.revision !== a.revision &&
    (a.needsRead || a.pending.size || b.needsRead || b.pending.size)
  ) {
    return b.revision - a.revision
  }
  const av = version(a.base),
    bv = version(b.base)
  return (Number.isFinite(av) && Number.isFinite(bv) ? bv - av : 0) || b.readOrder - a.readOrder
}
