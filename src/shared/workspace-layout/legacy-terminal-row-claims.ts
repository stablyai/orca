// Share stored-row ownership between startup hydration and Loader: sessions duplicate terminals in tab-bar entries and legacy workspace rows.

import { isValidTerminalTabId } from '../terminal-tab-id'
import type { TerminalTab } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'

export type CanonicalPtyOwners = {
  /** Terminal ids the tab bar owns in this workspace. */
  tabIds: Set<string>
  /** PTYs already claimed by tab-bar rows, keyed to their claimant. */
  tabIdByPtyId: Map<string, string>
}

export function readCanonicalPtyOwners(
  session: WorkspaceSessionState,
  workspaceKey: string,
  rows: readonly TerminalTab[]
): CanonicalPtyOwners {
  const tabIds = new Set(
    (session.unifiedTabs?.[workspaceKey] ?? [])
      .filter((tab) => tab.contentType === 'terminal')
      .map((tab) => tab.entityId)
  )
  // Only valid surviving rows can claim PTYs; invalid mirrors must not evict valid owners.
  const tabIdByPtyId = new Map(
    rows
      .filter((row) => tabIds.has(row.id) && isValidTerminalTabId(row.id))
      .flatMap((row) =>
        readPersistedTerminalPtyIds(session, row).claimable.map((ptyId) => [ptyId, row.id] as const)
      )
  )
  return { tabIds, tabIdByPtyId }
}

export type CanonicalPtyClaim =
  | { kind: 'subsumed'; canonicalTabId: string }
  | { kind: 'retained'; releasedPtyIds: Set<string>; reconnectPtyId?: string }

const RETAINED_UNCLAIMED: CanonicalPtyClaim = { kind: 'retained', releasedPtyIds: new Set() }

/** Canonical mounts win PTY ownership over stale legacy duplicates of the same terminal. */
export function resolveCanonicalPtyClaim(
  session: WorkspaceSessionState,
  row: TerminalTab,
  canonical: CanonicalPtyOwners
): CanonicalPtyClaim {
  if (canonical.tabIds.has(row.id)) {
    return RETAINED_UNCLAIMED
  }
  const { owned, orphaned, mountedByPrimacy } = readPersistedTerminalPtyIds(session, row)
  const claimed = owned.filter((ptyId) => canonical.tabIdByPtyId.has(ptyId))
  // Unclaimed/PTY-less rows have no canonical twin and cannot count as fully claimed.
  const canonicalTabId = claimed.length > 0 ? canonical.tabIdByPtyId.get(claimed[0]) : undefined
  if (canonicalTabId && claimed.length === owned.length) {
    return { kind: 'subsumed', canonicalTabId }
  }
  // Keep independent split panes but release shared and stale unmounted bindings or reconnect republishes a second PTY owner (#10486).
  const releasedPtyIds = new Set([
    ...claimed,
    ...orphaned.filter((ptyId) => canonical.tabIdByPtyId.has(ptyId))
  ])
  return {
    kind: 'retained',
    releasedPtyIds,
    // After yielding a PTY to a live canonical mount, anchor reconnect on the surviving pane (#10486).
    // A lone binding proves no liveness and must remain sweepable after SSH-target removal (#9911).
    reconnectPtyId:
      releasedPtyIds.size > 0
        ? mountedByPrimacy.find((ptyId) => !releasedPtyIds.has(ptyId))
        : undefined
  }
}

type PersistedTerminalPtyIds = {
  /** PTYs a live pane or the tab itself still reattaches to — the only ones that prove ownership. */
  owned: string[]
  /** The `owned` PTYs whose mount is unambiguous, so a canonical row may take them off another row. */
  claimable: string[]
  /** Live pane PTYs, active leaf first — the order a row picks its primary session from. */
  mountedByPrimacy: string[]
  /** PTYs stranded in `ptyIdsByLeafId` by panes that already left the tree; they reattach nothing. */
  orphaned: string[]
}

export function readPersistedTerminalPtyIds(
  session: WorkspaceSessionState,
  tab: TerminalTab
): PersistedTerminalPtyIds {
  const layout = session.terminalLayoutsByTabId?.[tab.id]
  // Hydration reads before normalization, so the merged/unpruned binding map can contain dead leaves. Rootless layouts treat bindings as mounted.
  const mountedLeafIds = layout?.root ? new Set(collectLayoutLeafIdsInOrder(layout.root)) : null
  const bindings = Object.entries(layout?.ptyIdsByLeafId ?? {}).filter(([, ptyId]) =>
    Boolean(ptyId)
  )
  const mounted: string[] = []
  const unmounted: string[] = []
  for (const [leafId, ptyId] of bindings) {
    ;(!mountedLeafIds || mountedLeafIds.has(leafId) ? mounted : unmounted).push(ptyId)
  }
  const tabLevel = [tab.ptyId, session.remoteSessionIdsByTabId?.[tab.id]].filter(
    (ptyId): ptyId is string => Boolean(ptyId)
  )
  const owned = new Set([...tabLevel, ...mounted])
  // Only a sole rootless binding proves ownership; claiming a stale multi-entry map could evict the real live owner (#13098).
  const provenLeafId = bindings.length === 1 ? bindings[0]![0] : layout?.activeLeafId
  const claimableLeafPtyIds = mountedLeafIds
    ? mounted
    : bindings.filter(([leafId]) => leafId === provenLeafId).map(([, ptyId]) => ptyId)
  const activeLeafPtyId = layout?.activeLeafId
    ? layout.ptyIdsByLeafId?.[layout.activeLeafId]
    : undefined
  const mountedByPrimacy =
    activeLeafPtyId && mounted.includes(activeLeafPtyId)
      ? [activeLeafPtyId, ...mounted.filter((ptyId) => ptyId !== activeLeafPtyId)]
      : mounted
  return {
    owned: [...owned],
    claimable: [...new Set([...tabLevel, ...claimableLeafPtyIds])],
    mountedByPrimacy: [...new Set(mountedByPrimacy)],
    orphaned: [...new Set(unmounted)].filter((ptyId) => !owned.has(ptyId))
  }
}
