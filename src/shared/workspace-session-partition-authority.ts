import type { WorkspaceSessionState } from './types'
import { parseWorkspaceKey } from './workspace-scope'
import { getRepoIdFromWorktreeId } from './worktree-id'
import {
  collectWorkspaceKeys,
  paneTabId,
  WORKTREE_RECORD_FIELDS
} from './workspace-session-partition-provenance'

export function repoIdForWorkspaceKey(key: string): string | null {
  const scope = parseWorkspaceKey(key)
  if (scope?.type === 'folder') {
    return null
  }
  return getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : key)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry
    }
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    )
  })
}

function workspaceBundle(session: WorkspaceSessionState, workspaceKey: string): unknown {
  const tabs = session.tabsByWorktree[workspaceKey] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  return {
    workspaceRecords: Object.fromEntries(
      WORKTREE_RECORD_FIELDS.map((field) => [field, session[field]?.[workspaceKey]])
    ),
    layouts: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId).filter(([tabId]) => tabIds.has(tabId))
    ),
    remoteSessions: Object.fromEntries(
      Object.entries(session.remoteSessionIdsByTabId ?? {}).filter(([tabId]) => tabIds.has(tabId))
    ),
    incarnations: Object.fromEntries(
      Object.entries(session.terminalPtyIncarnationsByPaneKey ?? {}).filter(([paneKey]) =>
        tabIds.has(paneTabId(paneKey))
      )
    ),
    sleepingAgents: Object.fromEntries(
      Object.entries(session.sleepingAgentSessionsByPaneKey ?? {}).filter(
        ([, record]) => record.worktreeId === workspaceKey
      )
    ),
    tombstones: Object.fromEntries(
      Object.entries(session.terminalSurfaceTombstonesByPaneKey ?? {}).filter(
        ([, tombstone]) => tombstone.worktreeId === workspaceKey
      )
    ),
    browserPages: Object.fromEntries(
      Object.entries(session.browserPagesByWorkspace ?? {}).filter(([, pages]) =>
        pages.some((page) => page.worktreeId === workspaceKey)
      )
    )
  }
}

export function workspaceSessionBundlesEquivalent(
  base: WorkspaceSessionState,
  source: WorkspaceSessionState,
  workspaceKey: string
): boolean {
  return (
    canonicalJson(workspaceBundle(base, workspaceKey)) ===
    canonicalJson(workspaceBundle(source, workspaceKey))
  )
}

export type WorkspaceTerminalAuthority = 'base' | 'source' | 'equivalent' | 'ambiguous'

export function workspaceTerminalAuthority(
  base: WorkspaceSessionState,
  source: WorkspaceSessionState,
  workspaceKey: string,
  presence?: { base: boolean; source: boolean }
): WorkspaceTerminalAuthority {
  const repoId = repoIdForWorkspaceKey(workspaceKey)
  const baseRevision = repoId ? (base.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) : 0
  const sourceRevision = repoId ? (source.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) : 0
  if (sourceRevision !== baseRevision) {
    return sourceRevision > baseRevision ? 'source' : 'base'
  }
  const baseHasKey = presence?.base ?? collectWorkspaceKeys(base).has(workspaceKey)
  const sourceHasKey = presence?.source ?? collectWorkspaceKeys(source).has(workspaceKey)
  if (sourceHasKey && !baseHasKey) {
    return 'source'
  }
  if (baseHasKey && !sourceHasKey) {
    return 'base'
  }
  const baseTabs = base.tabsByWorktree[workspaceKey] ?? []
  const sourceTabs = source.tabsByWorktree[workspaceKey] ?? []
  if (sourceTabs.length > 0 && baseTabs.length === 0) {
    return 'source'
  }
  if (baseTabs.length > 0 && sourceTabs.length === 0) {
    return 'base'
  }
  return workspaceSessionBundlesEquivalent(base, source, workspaceKey) ? 'equivalent' : 'ambiguous'
}

export function findAmbiguousWorkspaceSessionKeys(
  sources: readonly WorkspaceSessionState[]
): Set<string> {
  const ambiguous = new Set<string>()
  const keysBySource = sources.map(collectWorkspaceKeys)
  for (let left = 0; left < sources.length; left += 1) {
    for (let right = left + 1; right < sources.length; right += 1) {
      const keys = new Set([...keysBySource[left], ...keysBySource[right]])
      for (const key of keys) {
        if (
          workspaceTerminalAuthority(sources[left], sources[right], key, {
            base: keysBySource[left].has(key),
            source: keysBySource[right].has(key)
          }) === 'ambiguous'
        ) {
          ambiguous.add(key)
        }
      }
    }
  }
  return ambiguous
}

export function findCrossHostWorkspaceSessionKeyCollisions(
  sources: readonly WorkspaceSessionState[]
): Set<string> {
  const collisions = new Set<string>()
  const keysBySource = sources.map(collectWorkspaceKeys)
  for (let left = 0; left < sources.length; left += 1) {
    for (let right = left + 1; right < sources.length; right += 1) {
      for (const key of keysBySource[left]) {
        if (keysBySource[right].has(key)) {
          collisions.add(key)
        }
      }
    }
  }
  return collisions
}

export function findWorkspaceTabIdOwnerCollisions(
  sources: readonly WorkspaceSessionState[]
): Set<string> {
  const ownersByTabId = new Map<string, Set<string>>()
  for (const source of sources) {
    for (const [workspaceKey, tabs] of Object.entries(source.tabsByWorktree)) {
      for (const tab of tabs) {
        const owners = ownersByTabId.get(tab.id) ?? new Set<string>()
        owners.add(workspaceKey)
        ownersByTabId.set(tab.id, owners)
      }
    }
  }
  const collisions = new Set<string>()
  for (const owners of ownersByTabId.values()) {
    if (owners.size > 1) {
      for (const owner of owners) {
        collisions.add(owner)
      }
    }
  }
  return collisions
}
