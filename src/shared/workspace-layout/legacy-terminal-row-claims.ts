// Which stored terminal rows the tab bar already holds, read from stored data alone. A persisted
// session describes the same terminals twice: as tab-bar entries and as legacy per-workspace rows.
// The window's startup hydration and the shared Loader both resolve ownership with these rules.

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
  // Why: only rows that survive the id check can claim PTY ownership; a dropped invalid-id mirror must not evict the valid row sharing its PTY.
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
  // Why: an unclaimed row has no canonical twin, which also keeps a PTY-less row — it duplicates
  // nothing — out of the fully-claimed branch.
  const canonicalTabId = claimed.length > 0 ? canonical.tabIdByPtyId.get(claimed[0]) : undefined
  if (canonicalTabId && claimed.length === owned.length) {
    return { kind: 'subsumed', canonicalTabId }
  }
  // Why: a split row with an independent pane owns a PTY nothing else can reattach to, but keeping the
  // shared PTY too would leave two recorded owners and make ownership resolution ambiguous (#10486).
  // Stale unmounted bindings go too, else reconnect republishes the canonical PTY under this row.
  const releasedPtyIds = new Set([
    ...claimed,
    ...orphaned.filter((ptyId) => canonical.tabIdByPtyId.has(ptyId))
  ])
  return {
    kind: 'retained',
    releasedPtyIds,
    // Why: the surviving pane becomes this row's primary; reconnect anchors liveness on it so the
    // orphan sweep can't delete the row while its tab-level PTY is gone (#10486). Only a row that
    // just handed a PTY to a live canonical mount earns this — a leaf binding on its own proves
    // nothing and must stay sweepable (e.g. a layout outliving a removed SSH target, #9911).
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
  // Why: ptyIdsByLeafId is merged but never pruned, and hydration reads it before
  // normalizeTerminalLayoutSnapshot runs, so unmounted leaves still carry dead bindings here.
  // Rootless layouts bind their sole pane off-tree, so `owned` treats every entry as mounted.
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
  // Why: "sole pane off-tree" is the only rootless shape that proves ownership. A never-pruned map can
  // hold more, and claiming those would evict the live row that really owns them (#13098).
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
