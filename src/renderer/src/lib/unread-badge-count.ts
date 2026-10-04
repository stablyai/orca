import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { Tab } from '../../../shared/tab-types'
import type { AppState } from '@/store/types'
import { isExecutionHostAliasForWorktree } from './worktree-execution-host-alias'

/** The only fields the count reads, so a projection over them is a sound cache key. */
export type UnreadBadgeWorktree = Pick<
  Worktree,
  'id' | 'isUnread' | 'hostId' | 'runtimeOwnerEnvironmentId'
>
export type UnreadBadgeTab = Pick<TerminalTab, 'id'>
export type UnreadBadgeOwnedTab = Pick<Tab, 'id' | 'worktreeId' | 'executionHostId'>

export type UnreadBadgeCountSources = {
  worktreesByRepo: Readonly<Record<string, readonly UnreadBadgeWorktree[]>>
  tabsByWorktree: Readonly<Record<string, readonly UnreadBadgeTab[]>>
  unreadTerminalTabs: Readonly<Record<string, StoredAgentAttentionUnread>>
  hiddenChildUnreadIdentities?: ReadonlySet<string>
} & {
  [Field in keyof Pick<AppState, 'unifiedTabsByWorktree'>]?: Readonly<
    Record<string, readonly UnreadBadgeOwnedTab[]>
  >
}

export function getUnreadBadgeCount({
  worktreesByRepo,
  tabsByWorktree,
  unreadTerminalTabs,
  hiddenChildUnreadIdentities,
  unifiedTabsByWorktree
}: UnreadBadgeCountSources): number {
  const unreadWorktreeIds = new Set<string>()
  const hiddenWorktreesById = new Map<string, UnreadBadgeWorktree[]>()

  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (hiddenChildUnreadIdentities?.has(getWorktreeHostIdentity(worktree))) {
        const hidden = hiddenWorktreesById.get(worktree.id) ?? []
        hidden.push(worktree)
        hiddenWorktreesById.set(worktree.id, hidden)
      } else if (worktree.isUnread) {
        unreadWorktreeIds.add(worktree.id)
      }
    }
  }

  const unreadTabIds = new Set(Object.keys(unreadTerminalTabs))
  if (unreadTabIds.size === 0) {
    return unreadWorktreeIds.size
  }

  const worktreeIds = new Set([
    ...Object.keys(tabsByWorktree),
    ...Object.keys(unifiedTabsByWorktree ?? {})
  ])
  for (const worktreeId of worktreeIds) {
    const owners = new Map<string, UnreadBadgeOwnedTab | null>()
    for (const owner of unifiedTabsByWorktree?.[worktreeId] ?? []) {
      if (owner.worktreeId === worktreeId) {
        owners.set(owner.id, owners.has(owner.id) ? null : owner)
      }
    }
    // Structured-chat tabs have no backing terminal-tab record.
    const tabIds = new Set([
      ...(tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
      ...owners.keys()
    ])
    for (const tabId of tabIds) {
      if (!Object.hasOwn(unreadTerminalTabs, tabId)) {
        continue
      }
      unreadTabIds.delete(tabId)
      const host = owners.get(tabId)?.executionHostId
      // A loaded same-id row does not prove which host owns a tab.
      const hidden =
        host &&
        hiddenWorktreesById
          .get(worktreeId)
          ?.some((worktree) => isExecutionHostAliasForWorktree(host, worktree))
      if (!hidden) {
        unreadWorktreeIds.add(worktreeId)
      }
    }
  }

  // Why: tab unread state should normally map to a live worktree, but counting
  // unmatched entries keeps the Dock badge honest during hydration races.
  return unreadWorktreeIds.size + unreadTabIds.size
}
