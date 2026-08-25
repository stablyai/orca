import type { TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import {
  pickNextActiveTab,
  pushRecentTabId,
  sanitizeRecentTabIds
} from '../store/slices/tab-group-state'

/** A snapshot tab the client has not placed yet, plus the group it should join. */
export type ClientOwnedAdoptedTab = {
  tabId: string
  groupId: string
}

export type ClientOwnedPlacementInput = {
  currentGroups: readonly TabGroup[]
  worktreeId: string
  /** Every unified tab id that exists after this snapshot (retained + mirrored). */
  validUnifiedTabIds: ReadonlySet<string>
  /** Never-seen tabs in snapshot order; groupId is a hint (host group or fallback). */
  adoptedTabs: readonly ClientOwnedAdoptedTab[]
  /** Client-recorded placements; these are authoritative and may move an already-placed tab. */
  placementMoves: readonly ClientOwnedAdoptedTab[]
  /** Identity rekeys (provisional/local unified id → mirrored id); placement carries over. */
  rekeyedTabIds: ReadonlyMap<string, string>
  /** Explicit navigation intent (caller focus intent or 'follow'); the only focus authority. */
  intentTabId: string | null
  /**
   * The sibling tab to fall back to when the active group is a reserved preview split that
   * nothing visible occupies (STA-5001). Open Preview to the Side activates the empty split
   * before the host page lands; treating that as focus would move the user off the source
   * they are still editing.
   */
  reservedEmptyGroupFallbackTabId: string | null
  currentActiveGroupId: string | null
  currentLayout: TabGroupLayoutNode | null
  isGroupReserved(groupId: string): boolean
}

export type ClientOwnedPlacementResult = {
  groups: TabGroup[] | null
  activeGroupId: string | null
  layout: TabGroupLayoutNode | null
}

export function collectClientLayoutGroupIds(
  layout: TabGroupLayoutNode | null | undefined
): Set<string> {
  const result = new Set<string>()
  const visit = (node: TabGroupLayoutNode | null | undefined): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      result.add(node.groupId)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout)
  return result
}

export function pruneClientTabGroupLayout(
  layout: TabGroupLayoutNode | null | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return validGroupIds.has(layout.groupId) ? layout : null
  }
  const first = pruneClientTabGroupLayout(layout.first, validGroupIds)
  const second = pruneClientTabGroupLayout(layout.second, validGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}

type WorkingGroup = {
  group: TabGroup
  tabOrder: string[]
}

/**
 * Reconcile a snapshot into client-owned group state: place never-seen tabs at
 * the end of their target group, honor the client's own pending placement
 * records (which may move a tab placed provisionally before the create RPC
 * answered), drop vanished tabs (repairing a group's active tab exactly like a
 * local close), and change focus only on explicit navigation intent. The host
 * snapshot never reorders, regroups, or refocuses existing tabs here.
 */
export function reconcileClientOwnedTabPlacement(
  input: ClientOwnedPlacementInput
): ClientOwnedPlacementResult {
  const layoutGroupIds = collectClientLayoutGroupIds(input.currentLayout)
  const rekeyTabId = (tabId: string): string => input.rekeyedTabIds.get(tabId) ?? tabId
  const working = new Map<string, WorkingGroup>()
  const groupOrder: string[] = []
  for (const group of input.currentGroups) {
    const rekeyed =
      input.rekeyedTabIds.size === 0
        ? group
        : {
            ...group,
            tabOrder: group.tabOrder.map(rekeyTabId),
            activeTabId: group.activeTabId ? rekeyTabId(group.activeTabId) : group.activeTabId,
            recentTabIds: (group.recentTabIds ?? []).map(rekeyTabId)
          }
    working.set(group.id, {
      group: rekeyed,
      tabOrder: rekeyed.tabOrder.filter((tabId) => input.validUnifiedTabIds.has(tabId))
    })
    groupOrder.push(group.id)
  }
  const ensureGroup = (groupId: string): WorkingGroup => {
    const existing = working.get(groupId)
    if (existing) {
      return existing
    }
    // Why: a rendered layout leaf can precede its group record (hydration races) — repair it.
    const created: WorkingGroup = {
      group: {
        id: groupId,
        worktreeId: input.worktreeId,
        activeTabId: null,
        tabOrder: [],
        recentTabIds: []
      },
      tabOrder: []
    }
    working.set(groupId, created)
    groupOrder.push(groupId)
    return created
  }
  const activeGroupIdIfValid =
    input.currentActiveGroupId &&
    (working.has(input.currentActiveGroupId) || layoutGroupIds.has(input.currentActiveGroupId))
      ? input.currentActiveGroupId
      : null
  const resolveTargetGroupId = (requestedGroupId: string): string | undefined => {
    if (working.has(requestedGroupId) || layoutGroupIds.has(requestedGroupId)) {
      return requestedGroupId
    }
    return activeGroupIdIfValid ?? groupOrder[0]
  }

  const movedTabIds = new Set<string>()
  for (const move of input.placementMoves) {
    if (!input.validUnifiedTabIds.has(move.tabId)) {
      continue
    }
    const targetGroupId = resolveTargetGroupId(move.groupId)
    if (!targetGroupId) {
      continue
    }
    movedTabIds.add(move.tabId)
    for (const entry of working.values()) {
      if (entry.group.id !== targetGroupId) {
        entry.tabOrder = entry.tabOrder.filter((tabId) => tabId !== move.tabId)
      }
    }
    const target = ensureGroup(targetGroupId)
    if (!target.tabOrder.includes(move.tabId)) {
      target.tabOrder.push(move.tabId)
    }
  }
  for (const adopted of input.adoptedTabs) {
    if (movedTabIds.has(adopted.tabId) || !input.validUnifiedTabIds.has(adopted.tabId)) {
      continue
    }
    const targetGroupId = resolveTargetGroupId(adopted.groupId)
    if (!targetGroupId) {
      continue
    }
    const target = ensureGroup(targetGroupId)
    if (!target.tabOrder.includes(adopted.tabId)) {
      target.tabOrder.push(adopted.tabId)
    }
  }

  const reconciled: TabGroup[] = []
  for (const groupId of groupOrder) {
    const entry = working.get(groupId)
    if (!entry) {
      continue
    }
    const { group, tabOrder } = entry
    const intentActive =
      input.intentTabId && tabOrder.includes(input.intentTabId) ? input.intentTabId : null
    const displacedActive =
      group.activeTabId && !tabOrder.includes(group.activeTabId) ? group.activeTabId : null
    // Why: a host-side close (or a placement move away) must land the user where a local
    // close would (MRU, then neighbor), picking only among tabs surviving this snapshot.
    const repairOrder = displacedActive
      ? group.tabOrder.filter((tabId) => tabOrder.includes(tabId) || tabId === displacedActive)
      : null
    const activeTabId =
      intentActive ??
      (displacedActive && repairOrder
        ? (pickNextActiveTab(repairOrder, group.recentTabIds, displacedActive) ??
          tabOrder[0] ??
          null)
        : (group.activeTabId ?? tabOrder[0] ?? null))
    const validActiveTabId =
      activeTabId && tabOrder.includes(activeTabId) ? activeTabId : (tabOrder[0] ?? null)
    reconciled.push({
      ...group,
      tabOrder,
      activeTabId: validActiveTabId,
      recentTabIds: validActiveTabId
        ? pushRecentTabId(sanitizeRecentTabIds(group.recentTabIds, tabOrder), validActiveTabId)
        : []
    })
  }

  // Why: a group emptied because its tabs vanished collapses exactly like a local
  // last-tab close; only rendered-but-recordless repair groups and reserved
  // pending-create groups may stay empty.
  const emptiedGroupIds = new Set(
    reconciled
      .filter(
        (group) =>
          group.tabOrder.length === 0 &&
          !input.isGroupReserved(group.id) &&
          (working.get(group.id)?.group.tabOrder.length ?? 0) > 0
      )
      .map((group) => group.id)
  )
  let groups = reconciled.filter(
    (group) =>
      group.tabOrder.length > 0 ||
      input.isGroupReserved(group.id) ||
      (layoutGroupIds.has(group.id) && !emptiedGroupIds.has(group.id))
  )
  if (groups.length === 0 && reconciled.length > 0) {
    // Why: never drop to zero groups — closeUnifiedTab keeps the last pane too.
    const fallback =
      reconciled.find((group) => group.id === input.currentActiveGroupId) ?? reconciled[0]
    groups = [fallback]
  }
  const survivingGroupIds = new Set(groups.map((group) => group.id))
  const intentGroupId = input.intentTabId
    ? (groups.find((group) => group.tabOrder.includes(input.intentTabId as string))?.id ?? null)
    : null
  const reservedEmptyFallbackGroupId = input.reservedEmptyGroupFallbackTabId
    ? (groups.find((group) =>
        group.tabOrder.includes(input.reservedEmptyGroupFallbackTabId as string)
      )?.id ?? null)
    : null
  const nextActiveGroupId =
    intentGroupId ??
    reservedEmptyFallbackGroupId ??
    (input.currentActiveGroupId && survivingGroupIds.has(input.currentActiveGroupId)
      ? input.currentActiveGroupId
      : (groups.find((group) => layoutGroupIds.has(group.id))?.id ?? groups[0]?.id ?? null))
  let layout = pruneClientTabGroupLayout(input.currentLayout, survivingGroupIds)
  const renderedGroupIds = collectClientLayoutGroupIds(layout)
  // Why: a surviving group must stay reachable — repair hydration races by appending a leaf.
  for (const group of groups) {
    if (!renderedGroupIds.has(group.id)) {
      const leaf: TabGroupLayoutNode = { type: 'leaf', groupId: group.id }
      layout = layout
        ? { type: 'split', direction: 'horizontal', first: layout, second: leaf }
        : leaf
    }
  }
  return {
    groups: groups.length > 0 ? groups : null,
    activeGroupId: nextActiveGroupId,
    layout
  }
}
