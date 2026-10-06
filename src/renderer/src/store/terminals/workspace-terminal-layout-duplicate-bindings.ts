/**
 * Hydration self-heal for layouts that persist one leaf id — or one PTY id — under two tabs.
 *
 * Why: a mint bug can write the same leaf id, bound to the same PTY, into two tabs' layouts.
 * On the next launch both tabs mount that PTY. Renderer data delivery is one handler slot per
 * PTY id, so one pane starves, and both panes forward their fit, so the PTY grid flips between
 * two sizes. One tab keeps the binding; the other cold-starts its own shell.
 */
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { detachTerminalLayoutLeaf } from '@/components/terminal-pane/terminal-layout-leaf-detach'
import {
  collectLeafIdsInOrder,
  resolvePtyBoundActiveLeafId
} from '@/components/terminal-pane/terminal-layout-leaf-ids'

/** A layout's claim on a shared id, and the leaf that carries it. */
type LayoutBinding = { key: string; leafId: string }

export type DuplicateTerminalLayoutBindingResolution = {
  layoutsByTabId: Record<string, TerminalLayoutSnapshot>
  /** PTYs a losing tab just gave up, so reconnect withholds them from its row as well. */
  surrenderedPtyIdsByTabId: ReadonlyMap<string, ReadonlySet<string>>
}

type TabRanking = {
  canonicalTabIds: ReadonlySet<string>
  tabById: ReadonlyMap<string, TerminalTab>
}

/** Terminal ids the unified tab model owns, across every worktree the session describes. */
export function readCanonicalTerminalTabIds(session: WorkspaceSessionState): Set<string> {
  return new Set(
    Object.values(session.unifiedTabs ?? {}).flatMap((tabs) =>
      tabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
    )
  )
}

function readLeafBindings(layout: TerminalLayoutSnapshot): LayoutBinding[] {
  return collectLeafIdsInOrder(layout.root).map((leafId) => ({ key: leafId, leafId }))
}

/**
 * Why only leaves still in the tree: a binding whose pane already left reattaches nothing, so
 * it cannot starve the pane that does hold the PTY. Row hydration draws the same line — it
 * refuses to read a stranded binding as ownership — and counting one here would let a
 * never-pruned ghost outrank a live pane.
 */
function readPtyBindings(layout: TerminalLayoutSnapshot): LayoutBinding[] {
  const mountedLeafIds = new Set(collectLeafIdsInOrder(layout.root))
  return Object.entries(layout.ptyIdsByLeafId ?? {})
    .filter(([leafId]) => mountedLeafIds.has(leafId))
    .map(([leafId, ptyId]) => ({ key: ptyId, leafId }))
}

/** Canonical first, then the tab the user ordered first, then the older row, then id order. */
function compareOwnerTabIds(a: string, b: string, ranking: TabRanking): number {
  const aCanonical = ranking.canonicalTabIds.has(a)
  const bCanonical = ranking.canonicalTabIds.has(b)
  if (aCanonical !== bCanonical) {
    return aCanonical ? -1 : 1
  }
  const aTab = ranking.tabById.get(a)
  const bTab = ranking.tabById.get(b)
  // Why MAX_SAFE_INTEGER: a layout with no surviving row ranks behind every row that has one.
  return (
    (aTab?.sortOrder ?? Number.MAX_SAFE_INTEGER) - (bTab?.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
    (aTab?.createdAt ?? Number.MAX_SAFE_INTEGER) - (bTab?.createdAt ?? Number.MAX_SAFE_INTEGER) ||
    (a < b ? -1 : a > b ? 1 : 0)
  )
}

function dropPtyBinding(layout: TerminalLayoutSnapshot, leafId: string): TerminalLayoutSnapshot {
  const ptyIdsByLeafId = layout.ptyIdsByLeafId
  if (!ptyIdsByLeafId || !Object.hasOwn(ptyIdsByLeafId, leafId)) {
    return layout
  }
  const remaining = Object.fromEntries(
    Object.entries(ptyIdsByLeafId).filter(([boundLeafId]) => boundLeafId !== leafId)
  )
  return {
    ...layout,
    ptyIdsByLeafId: remaining,
    activeLeafId: resolvePtyBoundActiveLeafId({
      root: layout.root,
      activeLeafId: layout.activeLeafId,
      ptyIdsByLeafId: remaining
    })
  }
}

/**
 * A duplicated leaf id is an identity collision, so a split tab gives up the whole pane; a
 * single-leaf tab keeps its pane and cold-starts a shell rather than being left with no leaf.
 */
function surrenderLeaf(layout: TerminalLayoutSnapshot, leafId: string): TerminalLayoutSnapshot {
  return detachTerminalLayoutLeaf(layout, leafId)?.sourceLayout ?? dropPtyBinding(layout, leafId)
}

function applyDuplicateBindingPass(
  layoutsByTabId: Record<string, TerminalLayoutSnapshot>,
  readBindings: (layout: TerminalLayoutSnapshot) => LayoutBinding[],
  surrender: (layout: TerminalLayoutSnapshot, leafId: string) => TerminalLayoutSnapshot,
  ranking: TabRanking,
  surrenderedPtyIdsByTabId: Map<string, Set<string>>
): Record<string, TerminalLayoutSnapshot> {
  const claimantsByKey = new Map<string, Map<string, string>>()
  for (const [tabId, layout] of Object.entries(layoutsByTabId)) {
    for (const { key, leafId } of readBindings(layout)) {
      const claimants = claimantsByKey.get(key) ?? new Map<string, string>()
      claimantsByKey.set(key, claimants)
      if (!claimants.has(tabId)) {
        claimants.set(tabId, leafId)
      }
    }
  }

  const surrenderedLeafIdsByTabId = new Map<string, string[]>()
  for (const claimants of claimantsByKey.values()) {
    if (claimants.size < 2) {
      continue
    }
    // Why sort over reduce: the id tie-break makes the winner independent of iteration order.
    const [ownerTabId] = [...claimants.keys()].sort((a, b) => compareOwnerTabIds(a, b, ranking))
    for (const [tabId, leafId] of claimants) {
      if (tabId === ownerTabId) {
        continue
      }
      const surrendered = surrenderedLeafIdsByTabId.get(tabId) ?? []
      surrenderedLeafIdsByTabId.set(tabId, surrendered)
      if (!surrendered.includes(leafId)) {
        surrendered.push(leafId)
      }
    }
  }

  if (surrenderedLeafIdsByTabId.size === 0) {
    return layoutsByTabId
  }
  const healed = { ...layoutsByTabId }
  for (const [tabId, leafIds] of surrenderedLeafIdsByTabId) {
    for (const leafId of leafIds) {
      // Why recorded: the row's own `tab.ptyId` can name the same PTY, and reconnect would
      // otherwise hand it back through that tab-level fallback after the layout let it go.
      const surrenderedPtyId = healed[tabId].ptyIdsByLeafId?.[leafId]
      if (surrenderedPtyId) {
        const ptyIds = surrenderedPtyIdsByTabId.get(tabId) ?? new Set<string>()
        surrenderedPtyIdsByTabId.set(tabId, ptyIds)
        ptyIds.add(surrenderedPtyId)
      }
      healed[tabId] = surrender(healed[tabId], leafId)
    }
  }
  return healed
}

/**
 * Give every duplicated leaf id, then every duplicated PTY id, a single owning tab.
 * Returns the argument itself when nothing collides. The PTY pass reads the healed
 * layouts, so a leaf the first pass already surrendered is not counted twice — and it
 * only unbinds, because a PTY shared under two distinct leaf ids collides on the mount,
 * not on pane identity, so the losing pane is real and stays.
 */
export function resolveDuplicateTerminalLayoutBindings({
  canonicalTabIds,
  layoutsByTabId,
  tabById
}: {
  canonicalTabIds: ReadonlySet<string>
  layoutsByTabId: Record<string, TerminalLayoutSnapshot>
  tabById: ReadonlyMap<string, TerminalTab>
}): DuplicateTerminalLayoutBindingResolution {
  const ranking: TabRanking = { canonicalTabIds, tabById }
  const surrenderedPtyIdsByTabId = new Map<string, Set<string>>()
  const withUniqueLeafIds = applyDuplicateBindingPass(
    layoutsByTabId,
    readLeafBindings,
    surrenderLeaf,
    ranking,
    surrenderedPtyIdsByTabId
  )
  return {
    layoutsByTabId: applyDuplicateBindingPass(
      withUniqueLeafIds,
      readPtyBindings,
      dropPtyBinding,
      ranking,
      surrenderedPtyIdsByTabId
    ),
    surrenderedPtyIdsByTabId
  }
}
