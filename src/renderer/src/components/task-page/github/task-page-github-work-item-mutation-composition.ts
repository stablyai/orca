import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import {
  recomputeTaskPageGitHubItemSoftHide,
  shouldSoftHideTaskPageGitHubWorkItem
} from './task-page-github-work-item-filter-membership'
import { applyTaskPageGitHubListOps } from './task-page-github-work-item-mutation-patches'
import {
  deleteStickyHideEntry,
  getAllStickyHideEntries,
  getConfirmedListSnapshot,
  getTaskPageGitHubSoftHiddenItemKeys,
  hasConfirmedAuthorityForItem,
  listPendingTaskPageGitHubOpsForItem,
  resolveItemSourceScope,
  notifyTaskPageGitHubMutationRegistry,
  setSoftHiddenItemKeys,
  setStickyHideEntry,
  updateSoftHiddenItemKey
} from './task-page-github-work-item-mutation-registry'
import { getLastConfirmedClientValue } from './task-page-github-confirmed-client-values'
import { taskPageGitHubItemKey } from './task-page-github-work-item-mutation-keys'
import type {
  PendingListOp,
  PendingOp,
  TaskPageGitHubListFamily
} from './task-page-github-work-item-registry-types'

export function freezeTaskPageGitHubUsers(
  users: readonly GitHubAssignableUser[]
): GitHubAssignableUser[] {
  return users.map((user) => ({
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl
  }))
}

export function pendingListOpsForFamily(
  ops: readonly PendingOp[],
  family: TaskPageGitHubListFamily
): PendingListOp[] {
  // Keep the latest op per login so rapid toggles compose to the last intent.
  return [...ops]
    .filter((pending) => pending.listOp?.family === family)
    .sort((a, b) => a.startedAt - b.startedAt)
    .reduce<PendingListOp[]>((acc, pending) => {
      if (!pending.listOp) {
        return acc
      }
      if (pending.listOp.logins.length > 1) {
        acc.push(pending.listOp)
        return acc
      }
      const login = pending.listOp.logins[0]
      const lastIndex = acc.findIndex((op) => op.logins.length === 1 && op.logins[0] === login)
      if (lastIndex !== -1) {
        acc[lastIndex] = pending.listOp
      } else {
        acc.push(pending.listOp)
      }
      return acc
    }, [])
}

export function stripFamilyPendingFromList(
  item: GitHubWorkItem,
  family: TaskPageGitHubListFamily,
  ops: readonly PendingOp[]
): GitHubAssignableUser[] {
  const current = freezeTaskPageGitHubUsers(
    family === 'assignees' ? (item.assignees ?? []) : (item.reviewRequests ?? [])
  )
  let list = current
  const familyOps = pendingListOpsForFamily(ops, family)
  // Reverse pending adds/removes so lazy snapshots exclude in-flight intent.
  for (let i = familyOps.length - 1; i >= 0; i--) {
    const op = familyOps[i]
    for (let j = 0; j < op.logins.length; j++) {
      const login = op.logins[j]
      if (op.kind === 'add') {
        list = list.filter((user) => user.login.toLowerCase() !== login)
      } else if (!list.some((user) => user.login.toLowerCase() === login)) {
        const restored = op.users?.[j] ?? { login, name: null, avatarUrl: '' }
        list.push(restored)
      }
    }
  }
  return list
}

export function getRegistryMergedTaskPageGitHubWorkItem(
  item: GitHubWorkItem,
  sourceScope: string | null
): GitHubWorkItem {
  const ops = listPendingTaskPageGitHubOpsForItem(item.repoId, item.id, sourceScope)
  let merged: GitHubWorkItem = { ...item }

  // Hold confirmed whole-field values after pending clears until matching search adoption or newer intent.
  const lastState = getLastConfirmedClientValue(
    sourceScope,
    item.repoId,
    item.id,
    'state',
    parseGitHubIssueOrPRLink(item.url)?.slug ?? null
  )
  if (typeof lastState === 'string') {
    merged = { ...merged, state: lastState as GitHubWorkItem['state'] }
  }
  const lastAutoMerge = getLastConfirmedClientValue(sourceScope, item.repoId, item.id, 'autoMerge')
  if (typeof lastAutoMerge === 'boolean') {
    merged = { ...merged, autoMergeEnabled: lastAutoMerge }
  }

  const wholeByOpKey = new Map<string, PendingOp>()
  for (const op of ops) {
    if (op.listOp) {
      continue
    }
    wholeByOpKey.set(op.key.opKey, op)
  }
  for (const op of wholeByOpKey.values()) {
    merged = { ...merged, ...op.next }
  }

  for (const family of ['assignees', 'reviewRequests'] as const) {
    const familyOps = pendingListOpsForFamily(ops, family)
    let snapshot = getConfirmedListSnapshot(sourceScope, item.repoId, item.id, family)
    if (!snapshot && familyOps.length === 0) {
      continue
    }
    if (!snapshot) {
      snapshot = stripFamilyPendingFromList(item, family, ops)
    }
    const composed = applyTaskPageGitHubListOps(snapshot, familyOps)
    merged =
      family === 'assignees'
        ? { ...merged, assignees: composed }
        : { ...merged, reviewRequests: composed }
  }

  return merged
}

export function recomputeSoftHideForItem(args: {
  item: GitHubWorkItem
  sourceScope: string | null
  query: ParsedTaskQuery
  queryKey: string
  viewerLogin: string | null
  skipMeQualifiers: boolean
  /** When true (confirm/rollback), set or clear sticky per K22. */
  updateSticky: boolean
}): boolean {
  const merged = getRegistryMergedTaskPageGitHubWorkItem(args.item, args.sourceScope)
  const itemKey = taskPageGitHubItemKey(args.item.repoId, args.item.id)
  const membershipHide = shouldSoftHideTaskPageGitHubWorkItem({
    item: merged,
    query: args.query,
    viewerLogin: args.viewerLogin,
    skipMeQualifiers: args.skipMeQualifiers
  })

  if (args.updateSticky) {
    if (membershipHide) {
      setStickyHideEntry({
        itemKey,
        sourceScope: args.sourceScope,
        queryKey: args.queryKey,
        reason: 'filter_membership'
      })
    } else {
      deleteStickyHideEntry(itemKey)
    }
  }

  const result = recomputeTaskPageGitHubItemSoftHide({
    item: merged,
    query: args.query,
    viewerLogin: args.viewerLogin,
    skipMeQualifiers: args.skipMeQualifiers,
    queryKey: args.queryKey,
    sticky: getAllStickyHideEntries(),
    itemKey
  })
  updateSoftHiddenItemKey(itemKey, result.hide)
  return result.hide
}

export function rebuildSoftHiddenKeysFromPendingAndSticky(args: {
  query: ParsedTaskQuery
  queryKey: string
  viewerLogin: string | null
  items: readonly GitHubWorkItem[]
  skipMeByItemKey?: ReadonlyMap<string, boolean>
}): void {
  const next = new Set<string>()
  for (const [itemKey, entry] of getAllStickyHideEntries()) {
    if (entry.queryKey === args.queryKey) {
      next.add(itemKey)
    }
  }
  for (const item of args.items) {
    const ops = listPendingTaskPageGitHubOpsForItem(item.repoId, item.id)
    const itemKey = taskPageGitHubItemKey(item.repoId, item.id)
    if (
      ops.length === 0 &&
      !next.has(itemKey) &&
      !hasConfirmedAuthorityForItem(item.repoId, item.id)
    ) {
      continue
    }
    const sourceScope = ops[0]?.key.sourceScope ?? resolveItemSourceScope(item.repoId, item.id)
    const skipMe = args.skipMeByItemKey?.get(itemKey) ?? ops[0]?.skipMeQualifiers ?? false
    const merged = getRegistryMergedTaskPageGitHubWorkItem(item, sourceScope)
    if (
      shouldSoftHideTaskPageGitHubWorkItem({
        item: merged,
        query: args.query,
        viewerLogin: args.viewerLogin,
        skipMeQualifiers: skipMe
      })
    ) {
      next.add(itemKey)
    }
  }
  const current = getTaskPageGitHubSoftHiddenItemKeys()
  if (next.size === current.size && [...next].every((itemKey) => current.has(itemKey))) {
    return
  }
  setSoftHiddenItemKeys(next)
  notifyTaskPageGitHubMutationRegistry()
}

export function familiesFromPendingOp(op: PendingOp): string[] {
  if (op.listOp) {
    return [op.listOp.family]
  }
  if (op.key.opKey === 'merge') {
    return ['state', 'merge', 'autoMerge']
  }
  if (op.key.opKey === 'autoMerge') {
    return ['autoMerge']
  }
  if (op.key.opKey === 'state') {
    return ['state']
  }
  return [op.key.opKey]
}
