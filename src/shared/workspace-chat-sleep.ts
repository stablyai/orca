import type { ExecutionHostId } from './execution-host'
import type { Tab } from './tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from './worktree/host-qualified-identity'

export type SleptChatIdentity = { tabId: string; sessionId: string }
export type ExplicitlySleptChatsByWorkspace = Record<string, SleptChatIdentity[]>

export function sleptChatWorkspaceKey(worktreeId: string, hostId: ExecutionHostId): string {
  return composeWorktreeHostIdentity(hostId, worktreeId)
}

export function isChatExplicitlySlept(intents: ExplicitlySleptChatsByWorkspace, tab: Tab): boolean {
  if (!tab.executionHostId || tab.contentType !== 'agent-session') {
    return false
  }
  return (
    intents[sleptChatWorkspaceKey(tab.worktreeId, tab.executionHostId)]?.some(
      (entry) => entry.tabId === tab.id && entry.sessionId === tab.entityId
    ) ?? false
  )
}

export function withoutSleptChatsForWorkspaces(
  intents: ExplicitlySleptChatsByWorkspace,
  targets: readonly { id: string; hostId?: ExecutionHostId }[]
): ExplicitlySleptChatsByWorkspace {
  const next = { ...intents }
  let changed = false
  for (const key of Object.keys(next)) {
    if (
      targets.some(
        (target) =>
          target.id === getWorktreeIdFromHostIdentity(key) &&
          (!target.hostId || key === sleptChatWorkspaceKey(target.id, target.hostId))
      )
    ) {
      delete next[key]
      changed = true
    }
  }
  return changed ? next : intents
}

export function withoutSleptChatsForHosts(
  intents: ExplicitlySleptChatsByWorkspace,
  hosts: ReadonlySet<ExecutionHostId>
): ExplicitlySleptChatsByWorkspace {
  let next = intents
  for (const key of Object.keys(intents)) {
    const hostId = getExecutionHostIdFromWorktreeHostIdentity(key)
    if (!hostId || !hosts.has(hostId)) {
      continue
    }
    next = next === intents ? { ...intents } : next
    delete next[key]
  }
  return next
}

export function withoutReplacedSleptChats(
  intents: ExplicitlySleptChatsByWorkspace,
  tabsByWorktree: Record<string, Tab[]>,
  worktreeId: string
): ExplicitlySleptChatsByWorkspace {
  const tabs = tabsByWorktree[worktreeId]
  if (!tabs) {
    return intents
  }
  let next = intents
  for (const [key, entries] of Object.entries(intents)) {
    if (getWorktreeIdFromHostIdentity(key) !== worktreeId) {
      continue
    }
    const hostId = getExecutionHostIdFromWorktreeHostIdentity(key)
    const retained = entries.filter((entry) => {
      const tab = tabs.find(
        (candidate) => candidate.id === entry.tabId && candidate.executionHostId === hostId
      )
      if (!tab) {
        return true
      }
      return tab.entityId === entry.sessionId
    })
    if (retained.length === entries.length) {
      continue
    }
    next = next === intents ? { ...intents } : next
    if (retained.length) {
      next[key] = retained
    } else {
      delete next[key]
    }
  }
  return next
}

export function withRenamedSleptChatWorkspace(
  intents: ExplicitlySleptChatsByWorkspace,
  oldId: string,
  newId: string
): ExplicitlySleptChatsByWorkspace {
  let next = intents
  for (const [key, entries] of Object.entries(intents)) {
    if (getWorktreeIdFromHostIdentity(key) !== oldId) {
      continue
    }
    next = next === intents ? { ...intents } : next
    next[`${key.slice(0, key.length - oldId.length)}${newId}`] = entries
    delete next[key]
  }
  return next
}

export function renameSleptChatWorkspaceInSession(
  session: WorkspaceSessionState,
  oldId: string,
  newId: string
): boolean {
  const current = session.explicitlySleptChatsByWorkspace
  if (!current) {
    return false
  }
  const renamed = withRenamedSleptChatWorkspace(current, oldId, newId)
  session.explicitlySleptChatsByWorkspace = renamed
  return renamed !== current
}
