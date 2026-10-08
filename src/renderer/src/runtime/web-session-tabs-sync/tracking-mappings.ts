import type { WebSessionTabsSyncState } from './state'
import {
  hostSessionGroupIdByLocalKey,
  hostSessionTabIdByLocalKey,
  hostSessionTabMappingKeysByEnvironmentAndWorktree
} from './state'
import { resolveWebAgentSessionHandoff } from '../web-agent-session-handoff'

function hostSessionTabMappingKey(args: {
  environmentId: string
  worktreeId: string
  tabId: string
}): string {
  return `${args.environmentId}:${args.worktreeId}:${args.tabId}`
}

export function clearHostSessionTabIdMappings(environmentId: string, worktreeId: string): void {
  const mappingKeysByWorktree = hostSessionTabMappingKeysByEnvironmentAndWorktree.get(environmentId)
  const mappingKeys = mappingKeysByWorktree?.get(worktreeId)
  if (!mappingKeys) {
    return
  }
  for (const mappingKey of mappingKeys) {
    hostSessionTabIdByLocalKey.delete(mappingKey)
    hostSessionGroupIdByLocalKey.delete(mappingKey)
  }
  mappingKeysByWorktree?.delete(worktreeId)
  if (mappingKeysByWorktree?.size === 0) {
    hostSessionTabMappingKeysByEnvironmentAndWorktree.delete(environmentId)
  }
}

export function setHostSessionTabIdMapping(
  args: { environmentId: string; worktreeId: string; tabId: string },
  hostTabId: string,
  hostGroupId?: string
): void {
  const mappingKey = hostSessionTabMappingKey(args)
  hostSessionTabIdByLocalKey.set(mappingKey, hostTabId)
  if (hostGroupId) {
    hostSessionGroupIdByLocalKey.set(mappingKey, hostGroupId)
  } else {
    hostSessionGroupIdByLocalKey.delete(mappingKey)
  }
  const mappingKeysByWorktree =
    hostSessionTabMappingKeysByEnvironmentAndWorktree.get(args.environmentId) ?? new Map()
  const mappingKeys = mappingKeysByWorktree.get(args.worktreeId) ?? new Set<string>()
  mappingKeys.add(mappingKey)
  mappingKeysByWorktree.set(args.worktreeId, mappingKeys)
  hostSessionTabMappingKeysByEnvironmentAndWorktree.set(args.environmentId, mappingKeysByWorktree)
}

export function resolveHostSessionTabIdForWebSessionTab(
  _state: WebSessionTabsSyncState,
  args: { environmentId: string; worktreeId: string; tabId: string }
): string | null {
  return (
    hostSessionTabIdByLocalKey.get(hostSessionTabMappingKey(args)) ??
    // Why: structured create returns canonical identity before its confirming snapshot; an immediate user close must already target that host tab.
    resolveWebAgentSessionHandoff({
      environmentId: args.environmentId,
      worktreeId: args.worktreeId,
      provisionalTabId: args.tabId
    })
  )
}

/** The host group holding the host tab a local tab mirrors, as of the last applied snapshot. */
export function resolveHostSessionGroupIdForWebSessionTab(args: {
  environmentId: string
  worktreeId: string
  tabId: string
}): string | null {
  return hostSessionGroupIdByLocalKey.get(hostSessionTabMappingKey(args)) ?? null
}

/** Enumerate only this publishing host's workspace mappings. */
export function hostSessionTabIdsByLocalTabForWorktree(
  environmentId: string,
  worktreeId: string
): Map<string, string> {
  const prefix = hostSessionTabMappingKey({ environmentId, worktreeId, tabId: '' })
  const keys = hostSessionTabMappingKeysByEnvironmentAndWorktree.get(environmentId)?.get(worktreeId)
  const entries = new Map<string, string>()
  for (const key of keys ?? []) {
    const hostTabId = hostSessionTabIdByLocalKey.get(key)
    if (hostTabId !== undefined) {
      entries.set(key.slice(prefix.length), hostTabId)
    }
  }
  return entries
}

/** The local tab mirroring a host tab, or null when no mirrored tab claims it. */
export function resolveLocalTabIdForHostSessionTab(args: {
  environmentId: string
  worktreeId: string
  hostTabId: string
}): string | null {
  for (const [tabId, hostTabId] of hostSessionTabIdsByLocalTabForWorktree(
    args.environmentId,
    args.worktreeId
  )) {
    if (hostTabId === args.hostTabId) {
      return tabId
    }
  }
  return null
}
