import type { GitHubAssignableUser, GitHubWorkItem } from '../../../shared/types'
import type { TaskPageGitHubCloseAction } from './task-page-github-status-actions'
import {
  taskPageGitHubListOpKey,
  type PendingListOp,
  type TaskPageGitHubListFamily
} from './task-page-github-work-item-mutation-registry'

export type TaskPageGitHubMutationIntent =
  | { type: 'setState'; state: 'open' | 'closed'; closeAction?: TaskPageGitHubCloseAction }
  | { type: 'toggleAssignee'; user: GitHubAssignableUser }
  | { type: 'addReviewers'; logins: string[]; candidates: GitHubAssignableUser[] }
  | { type: 'removeReviewers'; logins: string[] }
  | { type: 'merge' }
  | { type: 'setAutoMerge'; enabled: boolean }

export type TaskPageGitHubWholeFieldPatch = {
  kind: 'whole'
  opKey: string
  previous: Partial<GitHubWorkItem>
  next: Partial<GitHubWorkItem>
  /** Families touched for quiet dirty-bit / lastConfirmed. */
  families: string[]
}

export type TaskPageGitHubListFieldPatch = {
  kind: 'list'
  opKey: string
  family: TaskPageGitHubListFamily
  listOp: PendingListOp
  previous: Partial<GitHubWorkItem>
  next: Partial<GitHubWorkItem>
  families: string[]
}

export type TaskPageGitHubBuiltPatch = TaskPageGitHubWholeFieldPatch | TaskPageGitHubListFieldPatch

function freezeUsers(users: readonly GitHubAssignableUser[]): GitHubAssignableUser[] {
  return users.map((user) => ({
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl
  }))
}

function normalizeLogin(login: string): string {
  return login.trim().replace(/^@/, '').toLowerCase()
}

/**
 * Apply pending list ops onto a confirmed snapshot.
 * Same login keeps only the latest op (callers should pre-collapse if needed).
 */
export function applyTaskPageGitHubListOps(
  snapshot: readonly GitHubAssignableUser[],
  ops: readonly PendingListOp[]
): GitHubAssignableUser[] {
  let list = freezeUsers(snapshot)
  for (const op of ops) {
    for (let i = 0; i < op.logins.length; i++) {
      const login = op.logins[i]
      if (op.kind === 'add') {
        if (!list.some((user) => user.login.toLowerCase() === login)) {
          const candidate = op.users?.[i]
          list.push(
            candidate
              ? { login: candidate.login, name: candidate.name, avatarUrl: candidate.avatarUrl }
              : { login, name: null, avatarUrl: '' }
          )
        }
      } else {
        list = list.filter((user) => user.login.toLowerCase() !== login)
      }
    }
  }
  return list
}

export function loginSetOfUsers(users: readonly GitHubAssignableUser[] | undefined): Set<string> {
  const set = new Set<string>()
  for (const user of users ?? []) {
    if (user.login) {
      set.add(user.login.toLowerCase())
    }
  }
  return set
}

export function loginSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const login of a) {
    if (!b.has(login)) {
      return false
    }
  }
  return true
}

function findUser(
  candidates: readonly GitHubAssignableUser[],
  loginLower: string
): GitHubAssignableUser | undefined {
  return candidates.find((user) => user.login.toLowerCase() === loginLower)
}

/**
 * Pure intent → frozen previous/next patches against a registry-merged base item.
 */
export function buildTaskPageGitHubWorkItemMutationPatch(
  baseItem: GitHubWorkItem,
  intent: TaskPageGitHubMutationIntent
): TaskPageGitHubBuiltPatch {
  switch (intent.type) {
    case 'setState': {
      return {
        kind: 'whole',
        opKey: 'state',
        previous: { state: baseItem.state },
        next: { state: intent.state },
        families: ['state']
      }
    }
    case 'merge': {
      return {
        kind: 'whole',
        opKey: 'merge',
        previous: {
          state: baseItem.state,
          autoMergeEnabled: baseItem.autoMergeEnabled
        },
        next: {
          state: 'merged',
          autoMergeEnabled: false
        },
        families: ['state', 'merge', 'autoMerge']
      }
    }
    case 'setAutoMerge': {
      return {
        kind: 'whole',
        opKey: 'autoMerge',
        previous: { autoMergeEnabled: baseItem.autoMergeEnabled },
        next: { autoMergeEnabled: intent.enabled },
        families: ['autoMerge']
      }
    }
    case 'toggleAssignee': {
      const login = normalizeLogin(intent.user.login)
      const current = freezeUsers(baseItem.assignees ?? [])
      const isOn = current.some((user) => user.login.toLowerCase() === login)
      const listOp: PendingListOp = isOn
        ? { family: 'assignees', kind: 'remove', logins: [login] }
        : {
            family: 'assignees',
            kind: 'add',
            logins: [login],
            users: [
              {
                login: intent.user.login,
                name: intent.user.name,
                avatarUrl: intent.user.avatarUrl
              }
            ]
          }
      const nextAssignees = applyTaskPageGitHubListOps(current, [listOp])
      return {
        kind: 'list',
        opKey: taskPageGitHubListOpKey('assignees', [login]),
        family: 'assignees',
        listOp,
        previous: { assignees: current },
        next: { assignees: nextAssignees },
        families: ['assignees']
      }
    }
    case 'addReviewers': {
      const logins = intent.logins.map(normalizeLogin).filter(Boolean)
      const unique = [...new Set(logins)]
      const users = unique.map((login) => {
        const fromCandidates = findUser(intent.candidates, login)
        const fromCurrent = findUser(baseItem.reviewRequests ?? [], login)
        return (
          fromCandidates ??
          fromCurrent ?? {
            login,
            name: null,
            avatarUrl: ''
          }
        )
      })
      const listOp: PendingListOp = {
        family: 'reviewRequests',
        kind: 'add',
        logins: unique,
        users: freezeUsers(users)
      }
      const current = freezeUsers(baseItem.reviewRequests ?? [])
      return {
        kind: 'list',
        opKey: taskPageGitHubListOpKey('reviewRequests', unique),
        family: 'reviewRequests',
        listOp,
        previous: { reviewRequests: current },
        next: { reviewRequests: applyTaskPageGitHubListOps(current, [listOp]) },
        families: ['reviewRequests']
      }
    }
    case 'removeReviewers': {
      const logins = intent.logins.map(normalizeLogin).filter(Boolean)
      const unique = [...new Set(logins)]
      const listOp: PendingListOp = {
        family: 'reviewRequests',
        kind: 'remove',
        logins: unique
      }
      const current = freezeUsers(baseItem.reviewRequests ?? [])
      return {
        kind: 'list',
        opKey: taskPageGitHubListOpKey('reviewRequests', unique),
        family: 'reviewRequests',
        listOp,
        previous: { reviewRequests: current },
        next: { reviewRequests: applyTaskPageGitHubListOps(current, [listOp]) },
        families: ['reviewRequests']
      }
    }
  }
}
