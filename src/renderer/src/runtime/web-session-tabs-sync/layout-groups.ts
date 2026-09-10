import type { RuntimeMobileSessionTabGroup } from '../../../../shared/runtime-types'
import type { TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  MirroredAgentTab,
  MirroredBrowserTab,
  MirroredEditorTab,
  TerminalSurface
} from './state'
import { toWebTerminalSurfaceTabId } from '../web-runtime-session'
import { clearHostSessionTabIdMappings, setHostSessionTabIdMapping } from './tracking-mappings'
import { isWebSessionBrowserPlacementGroupReserved } from '../web-session-browser-placement'
import { resolveWebSessionReorderedOrder } from '../web-session-reorder-intent'
import { mapHostRecentTabIds } from './tab-group-layout-tree'
import { pushRecentTabId, sanitizeRecentTabIds } from './state-equality-core'

export function buildHostToLocalTabIdMap({
  terminalSurfaces,
  terminalTabs,
  browserTabs,
  editorTabs,
  agentTabs
}: {
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
  agentTabs: readonly MirroredAgentTab[]
}): Map<string, string> {
  const hostToLocal = new Map<string, string>()
  const terminalIds = new Set(terminalTabs.map((tab) => tab.id))
  for (const surface of terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (terminalIds.has(localId)) {
      hostToLocal.set(surface.parentTabId, localId)
      hostToLocal.set(surface.id, localId)
    }
  }
  for (const entry of browserTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
    hostToLocal.set(entry.unifiedTab.id, entry.unifiedTab.id)
  }
  for (const entry of editorTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
  }
  for (const entry of agentTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
  }
  return hostToLocal
}

export function updateHostSessionTabIdMappings(args: {
  environmentId: string
  worktreeId: string
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
  agentTabs: readonly MirroredAgentTab[]
}): void {
  clearHostSessionTabIdMappings(args.environmentId, args.worktreeId)

  const mirroredTerminalIds = new Set(args.terminalTabs.map((tab) => tab.id))
  for (const surface of args.terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (mirroredTerminalIds.has(localId)) {
      setHostSessionTabIdMapping({ ...args, tabId: localId }, surface.parentTabId)
    }
  }
  for (const entry of args.browserTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
  for (const entry of args.editorTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
  for (const entry of args.agentTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
}

export function retainClientPlacedMirroredTabs(args: {
  groups: readonly TabGroup[]
  mirroredUnifiedIds: ReadonlySet<string>
  validUnifiedTabIds: ReadonlySet<string>
  clientGroupIdByLocalTabId: ReadonlyMap<string, string>
  nextActiveUnifiedTabId: string | null
}): TabGroup[] {
  return args.groups.map((group) => {
    const retainedTabOrder = group.tabOrder.filter(
      (tabId) =>
        args.validUnifiedTabIds.has(tabId) &&
        (!args.mirroredUnifiedIds.has(tabId) ||
          args.clientGroupIdByLocalTabId.get(tabId) === group.id)
    )
    const placedTabIds = [...args.clientGroupIdByLocalTabId]
      .filter(
        ([tabId, groupId]) =>
          groupId === group.id &&
          args.validUnifiedTabIds.has(tabId) &&
          !retainedTabOrder.includes(tabId)
      )
      .map(([tabId]) => tabId)
    const tabOrder = [...retainedTabOrder, ...placedTabIds]
    const activeTabId =
      args.nextActiveUnifiedTabId && tabOrder.includes(args.nextActiveUnifiedTabId)
        ? args.nextActiveUnifiedTabId
        : group.activeTabId && tabOrder.includes(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
    return {
      ...group,
      tabOrder,
      activeTabId,
      recentTabIds: activeTabId
        ? pushRecentTabId(sanitizeRecentTabIds(group.recentTabIds, tabOrder), activeTabId)
        : []
    }
  })
}

export function buildMirroredHostGroups({
  currentGroups,
  hostGroups,
  hostToLocalTabId,
  mirroredUnifiedIds,
  nextActiveUnifiedTabId,
  now,
  validUnifiedTabIds,
  environmentId,
  worktreeId,
  clientGroupIdByLocalTabId,
  honorSnapshotActiveFocus
}: {
  currentGroups: readonly TabGroup[]
  hostGroups: readonly RuntimeMobileSessionTabGroup[]
  hostToLocalTabId: ReadonlyMap<string, string>
  mirroredUnifiedIds: ReadonlySet<string>
  nextActiveUnifiedTabId: string | null
  now: number
  validUnifiedTabIds: ReadonlySet<string>
  environmentId: string
  worktreeId: string
  clientGroupIdByLocalTabId: ReadonlyMap<string, string>
  /** True only when this frame carries navigation intent — a client focus request, or a host
   *  `navigationIntent: 'follow'`. Unsolicited frames never move a client's focus (#5435). */
  honorSnapshotActiveFocus: boolean
}): TabGroup[] | null {
  const strippedGroups = retainClientPlacedMirroredTabs({
    groups: currentGroups,
    mirroredUnifiedIds,
    validUnifiedTabIds,
    clientGroupIdByLocalTabId,
    nextActiveUnifiedTabId
  })
  const groupsById = new Map(strippedGroups.map((group) => [group.id, group]))
  // Why pre-strip: stripping drops every mirrored tab this client did not place itself, so a group
  // whose tabs are all mirrored comes back with `activeTabId: null` and its focus looks unheld.
  // What the client was showing is only legible before that.
  const clientActiveTabIdByGroupId = new Map(
    currentGroups.map((group) => [group.id, group.activeTabId])
  )
  const orderedGroups: TabGroup[] = []
  const seen = new Set<string>()

  for (const hostGroup of hostGroups) {
    const existing = groupsById.get(hostGroup.id)
    const localHostOrder = hostGroup.tabOrder
      .map((tabId) => hostToLocalTabId.get(tabId))
      .filter(
        (tabId): tabId is string =>
          tabId !== undefined &&
          validUnifiedTabIds.has(tabId) &&
          !clientGroupIdByLocalTabId.has(tabId)
      )
    const localHostOrderIds = new Set(localHostOrder)
    const hostTabOrder = [
      ...(existing?.tabOrder.filter((tabId) => !localHostOrderIds.has(tabId)) ?? []),
      ...localHostOrder
    ]
    // Why: a pending client reorder wins over a stale pre-move host order until the host echoes the move (or membership changes).
    const tabOrder = resolveWebSessionReorderedOrder(
      { environmentId },
      worktreeId,
      hostGroup.id,
      hostTabOrder,
      now
    )
    if (tabOrder.length === 0) {
      continue
    }
    const activeFromHost =
      hostGroup.activeTabId !== null ? (hostToLocalTabId.get(hostGroup.activeTabId) ?? null) : null
    // Why this order: `activeFromHost` reports which tab the HOST has focused, which on a host
    // running an agent follows the working session. It answers "where is the host looking", not
    // "where should this client look", so it outranks the tab this client is showing only when the
    // frame carries intent. Without that, every republication repointed each group the client was
    // not currently visiting.
    const heldTabId = existing?.activeTabId ?? clientActiveTabIdByGroupId.get(hostGroup.id) ?? null
    const clientActiveTabId = heldTabId && tabOrder.includes(heldTabId) ? heldTabId : null
    const hostActiveTabId =
      activeFromHost && tabOrder.includes(activeFromHost) ? activeFromHost : null
    const activeTabId =
      (nextActiveUnifiedTabId && tabOrder.includes(nextActiveUnifiedTabId)
        ? nextActiveUnifiedTabId
        : null) ??
      (honorSnapshotActiveFocus ? hostActiveTabId : null) ??
      // A group this client has never shown has no focus to preserve, so the host's is the only
      // answer available — that is adoption, not an override.
      clientActiveTabId ??
      hostActiveTabId ??
      tabOrder[0] ??
      null
    orderedGroups.push({
      id: hostGroup.id,
      worktreeId,
      tabOrder,
      activeTabId,
      recentTabIds: activeTabId
        ? pushRecentTabId(
            mapHostRecentTabIds(hostGroup.recentTabIds, hostToLocalTabId, tabOrder),
            activeTabId
          )
        : []
    })
    seen.add(hostGroup.id)
  }

  for (const group of strippedGroups) {
    if (
      !seen.has(group.id) &&
      (group.tabOrder.length > 0 ||
        isWebSessionBrowserPlacementGroupReserved({ worktreeId, groupId: group.id }))
    ) {
      orderedGroups.push(group)
    }
  }

  return orderedGroups.length > 0 ? orderedGroups : null
}
