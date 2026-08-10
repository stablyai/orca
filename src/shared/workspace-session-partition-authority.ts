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

const EMPTY_WORKSPACE_BUNDLE_SIGNATURE = canonicalJson({
  workspaceRecords: {},
  layouts: {},
  remoteSessions: {},
  incarnations: {},
  sleepingAgents: {},
  tombstones: {},
  browserPages: {}
})

type WorkspaceSessionBundle = {
  workspaceRecords: Record<string, unknown>
  layouts: Record<string, unknown>
  remoteSessions: Record<string, unknown>
  incarnations: Record<string, unknown>
  sleepingAgents: Record<string, unknown>
  tombstones: Record<string, unknown>
  browserPages: Record<string, unknown>
}

export type WorkspaceSessionAuthorityIndex = {
  workspaceKeys: ReadonlySet<string>
  bundleSignaturesByWorkspaceKey: ReadonlyMap<string, string>
}

function emptyWorkspaceBundle(
  session: WorkspaceSessionState,
  workspaceKey: string
): WorkspaceSessionBundle {
  return {
    workspaceRecords: Object.fromEntries(
      WORKTREE_RECORD_FIELDS.map((field) => {
        const value = session[field]?.[workspaceKey]
        return [field, value === undefined ? undefined : canonicalJson(value)]
      })
    ),
    layouts: {},
    remoteSessions: {},
    incarnations: {},
    sleepingAgents: {},
    tombstones: {},
    browserPages: {}
  }
}

export function createWorkspaceSessionAuthorityIndex(
  session: WorkspaceSessionState
): WorkspaceSessionAuthorityIndex {
  const workspaceKeys = collectWorkspaceKeys(session)
  const bundles = new Map(
    [...workspaceKeys].map((workspaceKey) => [
      workspaceKey,
      emptyWorkspaceBundle(session, workspaceKey)
    ])
  )
  const ownersByTabId = new Map<string, Set<string>>()
  for (const [workspaceKey, tabs] of Object.entries(session.tabsByWorktree)) {
    for (const tab of tabs) {
      const owners = ownersByTabId.get(tab.id) ?? new Set<string>()
      owners.add(workspaceKey)
      ownersByTabId.set(tab.id, owners)
    }
  }
  const addForTabOwners = (
    field: 'layouts' | 'remoteSessions' | 'incarnations',
    recordKey: string,
    tabId: string,
    value: unknown
  ): void => {
    for (const workspaceKey of ownersByTabId.get(tabId) ?? []) {
      const bundle = bundles.get(workspaceKey)
      if (bundle) {
        bundle[field][recordKey] = value
      }
    }
  }
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
    addForTabOwners('layouts', tabId, tabId, canonicalJson(layout))
  }
  for (const [tabId, remoteSessionId] of Object.entries(session.remoteSessionIdsByTabId ?? {})) {
    addForTabOwners('remoteSessions', tabId, tabId, canonicalJson(remoteSessionId))
  }
  for (const [paneKey, incarnationId] of Object.entries(
    session.terminalPtyIncarnationsByPaneKey ?? {}
  )) {
    addForTabOwners('incarnations', paneKey, paneTabId(paneKey), canonicalJson(incarnationId))
  }
  for (const [paneKey, record] of Object.entries(session.sleepingAgentSessionsByPaneKey ?? {})) {
    const bundle = bundles.get(record.worktreeId)
    if (bundle) {
      bundle.sleepingAgents[paneKey] = canonicalJson(record)
    }
  }
  for (const [paneKey, tombstone] of Object.entries(
    session.terminalSurfaceTombstonesByPaneKey ?? {}
  )) {
    const bundle = bundles.get(tombstone.worktreeId)
    if (bundle) {
      bundle.tombstones[paneKey] = canonicalJson(tombstone)
    }
  }
  for (const [browserWorkspaceKey, pages] of Object.entries(
    session.browserPagesByWorkspace ?? {}
  )) {
    const pagesSignature = canonicalJson(pages)
    for (const workspaceKey of new Set(pages.map((page) => page.worktreeId))) {
      const bundle = bundles.get(workspaceKey)
      if (bundle) {
        bundle.browserPages[browserWorkspaceKey] = pagesSignature
      }
    }
  }
  return {
    workspaceKeys,
    bundleSignaturesByWorkspaceKey: new Map(
      [...bundles].map(([workspaceKey, bundle]) => [workspaceKey, canonicalJson(bundle)])
    )
  }
}

function indexedWorkspaceSessionBundlesEquivalent(
  base: WorkspaceSessionAuthorityIndex,
  source: WorkspaceSessionAuthorityIndex,
  workspaceKey: string
): boolean {
  return (
    (base.bundleSignaturesByWorkspaceKey.get(workspaceKey) ?? EMPTY_WORKSPACE_BUNDLE_SIGNATURE) ===
    (source.bundleSignaturesByWorkspaceKey.get(workspaceKey) ?? EMPTY_WORKSPACE_BUNDLE_SIGNATURE)
  )
}

export function workspaceSessionBundlesEquivalent(
  base: WorkspaceSessionState,
  source: WorkspaceSessionState,
  workspaceKey: string
): boolean {
  return indexedWorkspaceSessionBundlesEquivalent(
    createWorkspaceSessionAuthorityIndex(base),
    createWorkspaceSessionAuthorityIndex(source),
    workspaceKey
  )
}

export type WorkspaceTerminalAuthority = 'base' | 'source' | 'equivalent' | 'ambiguous'

export function workspaceTerminalAuthority(
  base: WorkspaceSessionState,
  source: WorkspaceSessionState,
  workspaceKey: string,
  presence?: { base: boolean; source: boolean },
  indexes?: {
    base: WorkspaceSessionAuthorityIndex
    source: WorkspaceSessionAuthorityIndex
  }
): WorkspaceTerminalAuthority {
  const repoId = repoIdForWorkspaceKey(workspaceKey)
  const baseRevision = repoId ? (base.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) : 0
  const sourceRevision = repoId ? (source.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) : 0
  if (sourceRevision !== baseRevision) {
    return sourceRevision > baseRevision ? 'source' : 'base'
  }
  const baseIndex = indexes?.base ?? createWorkspaceSessionAuthorityIndex(base)
  const sourceIndex = indexes?.source ?? createWorkspaceSessionAuthorityIndex(source)
  const baseHasKey = presence?.base ?? baseIndex.workspaceKeys.has(workspaceKey)
  const sourceHasKey = presence?.source ?? sourceIndex.workspaceKeys.has(workspaceKey)
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
  return indexedWorkspaceSessionBundlesEquivalent(baseIndex, sourceIndex, workspaceKey)
    ? 'equivalent'
    : 'ambiguous'
}

export function findAmbiguousWorkspaceSessionKeys(
  sources: readonly WorkspaceSessionState[]
): Set<string> {
  const ambiguous = new Set<string>()
  const indexes = sources.map(createWorkspaceSessionAuthorityIndex)
  const keysBySource = indexes.map((index) => index.workspaceKeys)
  for (let left = 0; left < sources.length; left += 1) {
    for (let right = left + 1; right < sources.length; right += 1) {
      const keys = new Set([...keysBySource[left], ...keysBySource[right]])
      for (const key of keys) {
        if (
          workspaceTerminalAuthority(
            sources[left],
            sources[right],
            key,
            {
              base: keysBySource[left].has(key),
              source: keysBySource[right].has(key)
            },
            {
              base: indexes[left],
              source: indexes[right]
            }
          ) === 'ambiguous'
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
