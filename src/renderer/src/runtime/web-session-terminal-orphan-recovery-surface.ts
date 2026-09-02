import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab,
  RuntimeTerminalListResult,
  RuntimeTerminalOrphanAdoptionClaim
} from '../../../shared/runtime-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from './web-terminal-surface-id'
import {
  isRemovedSnapshot,
  isValidReadySurface,
  surfaceKey,
  terminalLayoutLeafIds,
  terminalRowsBySurface
} from './web-session-terminal-orphan-recovery-surface-index'
export {
  isRemovedSnapshot,
  isValidReadySurface,
  surfaceKey,
  terminalLayoutLeafIds,
  terminalRowsBySurface
} from './web-session-terminal-orphan-recovery-surface-index'

import type { WebTerminalOrphanTopologyState } from './web-session-terminal-orphan-topology'

export type TerminalOrphanRecoveryState = WebTerminalOrphanTopologyState & {
  tabsByWorktree: Record<string, TerminalTab[]>
}

export type TerminalSurface = RuntimeMobileSessionTerminalClientTab
export type RecoveryDisposition = 'claim' | 'retain' | 'remove'

type RecoverySurfaceCoordinates = {
  tabId: string
  leafId: string
  surfaceKey: string
  localTab: TerminalTab
  incoming?: TerminalSurface
  pending: boolean
  expectedPtyId: string | null
  locallyActive: boolean
  /** A persisted binding whose leaf no longer appears in the layout tree. */
  offTree?: boolean
}

export type RecoverySurface = RecoverySurfaceCoordinates & { handle: string }
export type UnresolvedRecoverySurface = RecoverySurfaceCoordinates & { handle: null }
export type AnyRecoverySurface = RecoverySurface | UnresolvedRecoverySurface

export type PreparedRecovery = {
  candidates: RecoverySurface[]
  unresolved: UnresolvedRecoverySurface[]
  observed: RecoverySurface[]
  /** Stale bindings retained without liveness/adoption claims. */
  retained: AnyRecoverySurface[]
}

/** Claim-relevant topology token for fencing local tab mutations across RPC awaits. */
export function captureTerminalRecoveryTopologyToken(
  state: TerminalOrphanRecoveryState,
  worktreeId: string
): string {
  const tabs = state.tabsByWorktree[worktreeId]
  const groups = state.groupsByWorktree?.[worktreeId]
  return JSON.stringify({
    tabs: (tabs ?? []).map((tab) => {
      const layout = state.terminalLayoutsByTabId[tab.id]
      return {
        id: tab.id,
        ptyId: tab.ptyId,
        ptyIds: state.ptyIdsByTabId?.[tab.id],
        worktreeId: tab.worktreeId,
        sortOrder: tab.sortOrder,
        root: layout?.root,
        activeLeafId: layout?.activeLeafId,
        expandedLeafId: layout?.expandedLeafId,
        ptyIdsByLeafId: layout?.ptyIdsByLeafId
      }
    }),
    activeTabId: state.activeTabIdByWorktree[worktreeId],
    activeGroupId: state.activeGroupIdByWorktree[worktreeId],
    groups: (groups ?? []).map((group) => ({
      id: group.id,
      activeTabId: group.activeTabId,
      tabOrder: group.tabOrder,
      recentTabIds: group.recentTabIds
    })),
    groupLayout: state.layoutByWorktree?.[worktreeId]
  })
}

export function hasExactTerminalRetirementProof(
  snapshot: RuntimeMobileSessionTabsResult,
  surface: RecoverySurface
): boolean {
  return (
    surface.incoming === undefined &&
    snapshot.retiredTerminalSurfaces?.some(
      (retired) =>
        retired.parentTabId === surface.tabId &&
        retired.leafId === surface.leafId &&
        retired.terminal === surface.handle
    ) === true
  )
}

export function prepareTerminalOrphanRecovery(
  state: TerminalOrphanRecoveryState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): PreparedRecovery {
  if (isRemovedSnapshot(snapshot)) {
    return { candidates: [], unresolved: [], observed: [], retained: [] }
  }
  const rowsBySurface = terminalRowsBySurface(snapshot)
  const candidates: RecoverySurface[] = []
  const unresolved: UnresolvedRecoverySurface[] = []
  const observed: RecoverySurface[] = []
  const retained: AnyRecoverySurface[] = []
  for (const localTab of state.tabsByWorktree[snapshot.worktree] ?? []) {
    if (!isWebTerminalSurfaceTabId(localTab.id)) {
      continue
    }
    const layout = state.terminalLayoutsByTabId[localTab.id]
    const tabId = toHostSessionTabId(localTab.id)
    for (const { leafId, offTree } of terminalLayoutLeafIds(layout)) {
      const remotePtyId = layout?.ptyIdsByLeafId?.[leafId]
      const remote = remotePtyId ? parseRemoteRuntimePtyId(remotePtyId) : null
      const key = surfaceKey(tabId, leafId)
      const rows = rowsBySurface.get(key)
      const readyIncoming = rows?.find(isValidReadySurface)
      const incoming = readyIncoming ?? rows?.[0]
      const pending = incoming !== undefined && !isValidReadySurface(incoming)
      const coordinates = {
        tabId,
        leafId,
        surfaceKey: key,
        localTab,
        incoming,
        pending,
        expectedPtyId:
          pending && typeof incoming?.ptyId === 'string' && incoming.ptyId.length > 0
            ? incoming.ptyId
            : null,
        locallyActive:
          state.activeTabIdByWorktree[snapshot.worktree] === localTab.id &&
          layout?.activeLeafId === leafId
      }
      if (offTree) {
        // An off-tree binding has no trustworthy pane topology. Keep it visible
        // as evidence, but never list/claim/retire it from this recovery pass.
        retained.push({
          ...coordinates,
          offTree: true,
          handle: remote?.environmentId === environmentId ? remote.handle : null
        })
        continue
      }
      if (readyIncoming) {
        if (remote?.environmentId === environmentId) {
          observed.push({ ...coordinates, incoming: readyIncoming, handle: remote.handle })
        }
        continue
      }
      if (remote?.environmentId === environmentId) {
        candidates.push({ ...coordinates, handle: remote.handle })
      } else if (!remotePtyId) {
        unresolved.push({ ...coordinates, handle: null })
      }
    }
  }
  return { candidates, unresolved, observed, retained }
}

export function buildRetainedTerminalSurface(surface: AnyRecoverySurface): TerminalSurface {
  const incoming = surface.incoming
  const localTitle = typeof surface.localTab.title === 'string' ? surface.localTab.title.trim() : ''
  if (!surface.handle) {
    return {
      ...(incoming ?? {
        type: 'terminal',
        id: `${surface.tabId}::${surface.leafId}`,
        parentTabId: surface.tabId,
        leafId: surface.leafId,
        title: localTitle || 'Terminal',
        isActive: surface.locallyActive
      }),
      type: 'terminal',
      id: incoming?.id ?? `${surface.tabId}::${surface.leafId}`,
      parentTabId: surface.tabId,
      leafId: surface.leafId,
      title: incoming?.title?.trim() || localTitle || 'Terminal',
      isActive: incoming?.isActive ?? surface.locallyActive,
      status: 'pending-handle',
      terminal: null
    }
  }
  const base: TerminalSurface = incoming ?? {
    type: 'terminal',
    id: `${surface.tabId}::${surface.leafId}`,
    parentTabId: surface.tabId,
    leafId: surface.leafId,
    title: localTitle || 'Terminal',
    isActive: surface.locallyActive,
    status: 'pending-handle',
    terminal: null
  }
  return {
    ...base,
    type: 'terminal',
    id: incoming?.id ?? `${surface.tabId}::${surface.leafId}`,
    parentTabId: surface.tabId,
    leafId: surface.leafId,
    title: incoming?.title?.trim() || localTitle || 'Terminal',
    isActive: incoming?.isActive ?? surface.locallyActive,
    status: 'ready',
    terminal: surface.handle
  }
}

export function mergeRetainedTerminalSurfaces(
  snapshot: RuntimeMobileSessionTabsResult,
  surfaces: readonly AnyRecoverySurface[],
  filteredSurfaceKeys: ReadonlySet<string> = new Set()
): RuntimeMobileSessionTabsResult {
  if (surfaces.length === 0 && filteredSurfaceKeys.size === 0) {
    return snapshot
  }
  const retainedByKey = new Map(
    surfaces.map((surface) => [surface.surfaceKey, buildRetainedTerminalSurface(surface)] as const)
  )
  const seen = new Set<string>()
  const tabs = snapshot.tabs.flatMap<RuntimeMobileSessionClientTab>((tab) => {
    if (tab.type !== 'terminal') {
      return [tab]
    }
    const key = surfaceKey(tab.parentTabId, tab.leafId)
    if (filteredSurfaceKeys.has(key)) {
      return []
    }
    const retained = retainedByKey.get(key)
    if (!retained) {
      return [tab]
    }
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [retained]
  })
  for (const surface of surfaces) {
    if (seen.has(surface.surfaceKey)) {
      continue
    }
    const row = retainedByKey.get(surface.surfaceKey)
    if (!row) {
      continue
    }
    let insertAt = -1
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      const tab = tabs[index]
      if (tab.type === 'terminal' && tab.parentTabId === surface.tabId) {
        insertAt = index + 1
        break
      }
    }
    if (insertAt < 0) {
      tabs.push(row)
    } else {
      tabs.splice(insertAt, 0, row)
    }
    seen.add(surface.surfaceKey)
  }
  const changed =
    tabs.length !== snapshot.tabs.length || tabs.some((tab, index) => tab !== snapshot.tabs[index])
  return changed ? { ...snapshot, tabs } : snapshot
}

export function hasStrongOrphanIdentity(
  terminal: RuntimeTerminalListResult['terminals'][number],
  surface: RecoverySurface,
  worktreeId: string
): boolean {
  return (
    terminal.handle === surface.handle &&
    terminal.orphaned === true &&
    typeof terminal.ptyId === 'string' &&
    terminal.ptyId.length > 0 &&
    typeof terminal.incarnationId === 'string' &&
    terminal.incarnationId.length > 0 &&
    (typeof terminal.worktreeId !== 'string' || terminal.worktreeId === worktreeId)
  )
}

export function buildTopologyCandidates(
  candidates: readonly RecoverySurface[],
  claims: readonly RuntimeTerminalOrphanAdoptionClaim[]
): TerminalTab[] {
  const claimedTabIds = new Set(claims.map((claim) => claim.tabId))
  return [
    ...new Map(
      candidates
        .filter((surface) => claimedTabIds.has(surface.tabId))
        .map((surface) => [surface.localTab.id, surface.localTab] as const)
    ).values()
  ]
}
