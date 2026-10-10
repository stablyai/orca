import {
  collectRuntimePaneLeafIds,
  resolveRuntimePaneTitleLeafId
} from '@/lib/runtime-pane-title-leaf-id'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { normalizeCompatibleAgentTitleForOwner } from '../../../../shared/agent-title-owner'
import { resolvePaneAgentOwnerRecord } from '../../../../shared/pane-agent-owner'
import {
  isFencedClientAgentStatus,
  hostAgentStatusPiercesClientAuthority
} from './agent-status-primitives'
import { writableWebSessionTabsRecord } from './state-equality-core'
import type {
  MirroredTerminalTab,
  TerminalSurface,
  WebSessionTabsBatchContext,
  WebSessionTabsSyncState
} from './state'

/** Reconcile saved pane titles with the accepted host inventory, including inactive tabs. */
export function buildMirroredRuntimePaneTitlePatch(
  state: WebSessionTabsSyncState,
  tabs: readonly MirroredTerminalTab[],
  surfaces: readonly TerminalSurface[],
  now: number,
  batchContext?: WebSessionTabsBatchContext
): Partial<WebSessionTabsSyncState> | null {
  const titles = state.runtimePaneTitlesByTabId
  if (!titles) {
    return null
  }
  const surfacesByTab = new Map<string, Map<string, TerminalSurface>>()
  for (const surface of surfaces) {
    const byLeaf = surfacesByTab.get(surface.parentTabId) ?? new Map<string, TerminalSurface>()
    byLeaf.set(surface.leafId, surface)
    surfacesByTab.set(surface.parentTabId, byLeaf)
  }
  let nextTitles = titles
  for (const { tab, hostTabId, layout, retainedSurfaceByPrunedLeafId } of tabs) {
    const paneTitles = titles[tab.id]
    if (!paneTitles) {
      continue
    }
    const leaves = new Set(collectRuntimePaneLeafIds(layout.root))
    const hostSurfacesByLeaf = new Map(surfacesByTab.get(hostTabId))
    for (const [hostLeafId, retainedSurface] of retainedSurfaceByPrunedLeafId ?? []) {
      const surface = hostSurfacesByLeaf.get(hostLeafId)
      if (surface) {
        hostSurfacesByLeaf.set(retainedSurface.leafId, surface)
      }
    }
    let nextPaneTitles: Record<string, string> = paneTitles
    for (const [runtimePaneId, title] of Object.entries(paneTitles)) {
      const leafId = resolveRuntimePaneTitleLeafId(layout, runtimePaneId)
      const hostSurface = leafId && leaves.has(leafId) ? hostSurfacesByLeaf.get(leafId) : undefined
      let hostTitle: string | undefined
      if (leafId && hostSurface) {
        // A pending handle's placeholder carries no new title evidence.
        if (
          !hostSurface.title.trim() ||
          (hostSurface.status === 'pending-handle' && hostSurface.title === 'Terminal')
        ) {
          continue
        }
        const paneKey = makePaneKey(tab.id, leafId)
        // Keep the existing byte-stream ownership fence while that writer is fresh.
        if (
          isFencedClientAgentStatus(paneKey, state.agentStatusByPaneKey[paneKey], now) &&
          !(
            hostSurface.agentStatus &&
            hostAgentStatusPiercesClientAuthority(hostSurface.agentStatus)
          )
        ) {
          continue
        }
        const owner = resolvePaneAgentOwnerRecord({
          launchAgent: hostSurface.launchAgent ?? tab.launchAgent,
          hookAgent: hostSurface.agentStatus?.agentType
        })
        hostTitle = normalizeCompatibleAgentTitleForOwner(hostSurface.title, owner?.agent, {
          ownerIsLaunch: owner?.ownerIsLaunch === true
        })
        if (title === hostTitle) {
          continue
        }
      }
      if (nextPaneTitles === paneTitles) {
        nextPaneTitles = { ...paneTitles }
      }
      // Runtime slots remain numeric until the pane manager migrates; refresh their values in place.
      if (hostTitle !== undefined) {
        nextPaneTitles[runtimePaneId] = hostTitle
      } else {
        delete nextPaneTitles[runtimePaneId]
      }
    }
    if (nextPaneTitles === paneTitles) {
      continue
    }
    if (nextTitles === titles) {
      nextTitles = writableWebSessionTabsRecord(state, 'runtimePaneTitlesByTabId', batchContext)
    }
    nextTitles[tab.id] = nextPaneTitles
  }
  return nextTitles === titles ? null : { runtimePaneTitlesByTabId: nextTitles }
}
