import {
  collectRuntimePaneLeafIds,
  isRuntimePaneTitleOrphan,
  resolveRuntimePaneTitleLeafId,
  resolveRuntimePaneTitleLeafIdFromSparseSlots
} from '../../../../shared/runtime-pane-title-leaf-id'
import { FIRST_PANE_ID } from '../../../../shared/pane-key'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { normalizeCompatibleAgentTitleForOwner } from '../../../../shared/agent-status/title/agent-title-owner'
import { resolvePaneAgentOwnerRecord } from '../../../../shared/agent-status/identity/pane-agent-owner'
import { findRegisteredTerminalTab } from '../hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { clientAgentStatusFencesHost } from './agent-status-primitives'
import { presentationRecordDraft, finishPresentationRecord } from './presentation-record-drafts'
import type {
  MirroredTerminalTab,
  WebSessionTabsBatchContext,
  WebSessionTabsSyncState
} from './state'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../shared/runtime-mobile-session-tab-contracts'

/** Reconcile saved pane titles with the accepted host inventory, including inactive tabs. */
export function buildMirroredRuntimePaneTitlePatch(
  state: WebSessionTabsSyncState,
  tabs: readonly MirroredTerminalTab[],
  surfaces: readonly RuntimeMobileSessionTerminalClientTab[],
  now: number,
  batchContext?: WebSessionTabsBatchContext
): Partial<WebSessionTabsSyncState> | null {
  const titles = state.runtimePaneTitlesByTabId
  if (!titles) {
    return null
  }
  const titledTabs = tabs.flatMap((entry) => {
    const paneTitles = titles[entry.tab.id]
    return paneTitles ? [{ ...entry, paneTitles }] : []
  })
  if (titledTabs.length === 0) {
    return null
  }
  const surfacesByTab = new Map<string, Map<string, RuntimeMobileSessionTerminalClientTab>>()
  for (const surface of surfaces) {
    const byLeaf =
      surfacesByTab.get(surface.parentTabId) ??
      new Map<string, RuntimeMobileSessionTerminalClientTab>()
    byLeaf.set(surface.leafId, surface)
    surfacesByTab.set(surface.parentTabId, byLeaf)
  }
  const draft = presentationRecordDraft(state, 'runtimePaneTitlesByTabId', batchContext)
  for (const { tab, hostTabId, layout, retainedSurfaceByPrunedLeafId, paneTitles } of titledTabs) {
    const leaves = new Set(collectRuntimePaneLeafIds(layout.root))
    const liveSlotIds = Object.keys(paneTitles)
      .map(Number)
      .filter((id) => Number.isInteger(id) && id >= FIRST_PANE_ID)
      .sort((a, b) => a - b)
    const liveSlotsAreDense =
      liveSlotIds.length === leaves.size &&
      liveSlotIds.every((id, index) => id === FIRST_PANE_ID + index)
    const manager = findRegisteredTerminalTab(tab.id, tab.worktreeId)?.tab.getManager()
    const hostSurfacesByLeaf = new Map(surfacesByTab.get(hostTabId))
    for (const [hostLeafId, retainedSurface] of retainedSurfaceByPrunedLeafId ?? []) {
      const surface = hostSurfacesByLeaf.get(hostLeafId)
      if (surface) {
        hostSurfacesByLeaf.set(retainedSurface.leafId, surface)
      }
    }
    let nextPaneTitles: Record<string, string> = paneTitles
    for (const [runtimePaneId, title] of Object.entries(paneTitles)) {
      const leafId = isTerminalLeafId(runtimePaneId)
        ? runtimePaneId
        : manager
          ? manager.getLeafId(Number(runtimePaneId))
          : (resolveRuntimePaneTitleLeafIdFromSparseSlots({
              layout: state.terminalLayoutsByTabId[tab.id],
              paneId: Number(runtimePaneId),
              liveSlotIds,
              ptyIds: state.ptyIdsByTabId[tab.id] ?? []
            }) ?? (liveSlotsAreDense ? resolveRuntimePaneTitleLeafId(layout, runtimePaneId) : null))
      // Why: a slot the layout cannot place is not proof the pane was removed.
      if (leafId === null) {
        continue
      }
      const hostSurface = leaves.has(leafId) ? hostSurfacesByLeaf.get(leafId) : undefined
      let hostTitle: string | undefined
      if (hostSurface) {
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
          clientAgentStatusFencesHost(
            paneKey,
            state.agentStatusByPaneKey.get(paneKey),
            hostSurface.agentStatus,
            now
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
      } else if (
        !isRuntimePaneTitleOrphan(runtimePaneId, leaves) ||
        manager?.getNumericIdForLeaf(runtimePaneId) != null
      ) {
        // Only a durable leaf absent from both the host layout and local panes proves removal.
        continue
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
    draft.set(tab.id, nextPaneTitles)
  }
  const nextTitles = finishPresentationRecord(
    state,
    'runtimePaneTitlesByTabId',
    draft,
    batchContext
  )
  return nextTitles === titles ? null : { runtimePaneTitlesByTabId: nextTitles }
}
