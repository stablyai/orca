import { getEagerPtyBufferHandle } from '@/components/terminal-pane/pty-dispatcher'
import { warnTerminalLifecycleAnomaly } from '@/components/terminal-pane/terminal-lifecycle-diagnostics'
import {
  collectParkedTerminalWatcherPtyIds,
  getParkedTerminalWatcherPaneIdsByPtyId
} from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { serializePaneTree } from '@/components/terminal-pane/layout-serialization'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeRendererSyncWindowGraph
} from '../../../../shared/runtime-types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { applyNativeChatLaunchDraftResolved } from '../native-chat-launch-draft-runtime-resolution'
import { resolveTerminalLayoutRoot } from '../remote-terminal-layout-resolution'
import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'
import { isWebOnlyMirroredTerminalTab } from './mobile-session-surfaces'
import { resolveRuntimeTerminalTitle } from './sync-projections'
import {
  collectAmbiguousTerminalTabIds,
  findRegisteredTerminalTab,
  graphState,
  mobilePublicationEpoch,
  NO_TRANSPORT_GRACE_MS
} from './graph-state'

export async function syncRuntimeGraph(): Promise<void> {
  if (!graphState.syncEnabled || !graphState.getStoreState) {
    return
  }
  // The store getter is injected to break the terminal-slice construction cycle.
  const state = graphState.getStoreState()
  const systemPrefersDark = getSystemPrefersDark()
  const ambiguousTerminalTabIds = collectAmbiguousTerminalTabIds(state.tabsByWorktree)
  const terminalTabsByWorktree = new Map<string, Map<string, TerminalTab>>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tabsById = new Map<string, TerminalTab>()
    for (const tab of tabs) {
      // Duplicate ids in one worktree are malformed persisted state; don't
      // guess which PTY a mounted surface owns.
      if (tabsById.has(tab.id)) {
        tabsById.delete(tab.id)
        continue
      }
      tabsById.set(tab.id, tab)
    }
    terminalTabsByWorktree.set(worktreeId, tabsById)
  }
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true
  const mobileSessionTabs = buildMobileSessionTabSnapshots(
    state,
    systemPrefersDark,
    ambiguousTerminalTabIds
  )
  const publication = partitionMobileSessionPublication(mobileSessionTabs)
  const graph: RuntimeRendererSyncWindowGraph = {
    tabs: [],
    leaves: [],
    rendererGeneration: mobilePublicationEpoch,
    mobileSessionTabs: publication.changed,
    unchangedMobileSessionWorktrees: publication.unchangedWorktrees
  }

  for (const [registrationKey, registeredTab] of graphState.registeredTabs) {
    if (ambiguousTerminalTabIds.has(registeredTab.tabId)) {
      continue
    }
    const tab = terminalTabsByWorktree.get(registeredTab.worktreeId)?.get(registeredTab.tabId)
    if (!tab) {
      continue
    }
    if (isWebOnlyMirroredTerminalTab(tab, state.terminalLayoutsByTabId[registeredTab.tabId])) {
      continue
    }
    const manager = registeredTab.getManager()
    const container = registeredTab.getContainer()
    const activePaneId = manager?.getActivePane()?.id ?? null
    const root =
      container?.firstElementChild instanceof HTMLElement ? container.firstElementChild : null
    graph.tabs.push({
      tabId: registeredTab.tabId,
      worktreeId: registeredTab.worktreeId,
      title: resolveRuntimeTerminalTitle(tab, generatedTitlesEnabled),
      activeLeafId: activePaneId === null ? null : (manager?.getLeafId(activePaneId) ?? null),
      layout: serializePaneTree(root)
    })
    const savedPtyIdsByLeafId =
      state.terminalLayoutsByTabId[registeredTab.tabId]?.ptyIdsByLeafId ?? {}
    for (const pane of manager?.getPanes() ?? []) {
      const leafId = pane.leafId
      const ptyId = registeredTab.getPtyIdForPane(pane.id)
      const savedPtyId = savedPtyIdsByLeafId[leafId] ?? null
      const registeredTime = graphState.tabRegisteredAt.get(registrationKey) ?? 0
      if (!ptyId && savedPtyId && Date.now() - registeredTime > NO_TRANSPORT_GRACE_MS) {
        warnTerminalLifecycleAnomaly('mounted terminal leaf has saved PTY but no live transport', {
          tabId: registeredTab.tabId,
          worktreeId: registeredTab.worktreeId,
          leafId,
          paneId: pane.id,
          ptyId: savedPtyId
        })
      }
      const paneTitles = state.runtimePaneTitlesByTabId[registeredTab.tabId] ?? {}
      graph.leaves.push({
        tabId: registeredTab.tabId,
        worktreeId: registeredTab.worktreeId,
        leafId,
        paneRuntimeId: pane.id,
        ptyId,
        paneTitle: paneTitles[pane.id] ?? null,
        title: resolveRuntimeTerminalTitle(
          tab,
          generatedTitlesEnabled,
          state.runtimePaneTitlesByTabId[registeredTab.tabId]?.[pane.id] ?? tab.title
        )
      })
    }
  }

  // Inactive automation/cold-parked tabs do not mount a TerminalPane; publish persisted leaves
  // only when a live eager buffer or parked watcher proves the PTY is still owned.
  const parkedWatcherPtyIds = collectParkedTerminalWatcherPtyIds()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      if (ambiguousTerminalTabIds.has(tab.id)) {
        continue
      }
      const layout = state.terminalLayoutsByTabId[tab.id]
      if (
        findRegisteredTerminalTab(tab.id, worktreeId) !== null ||
        isWebOnlyMirroredTerminalTab(tab, layout)
      ) {
        continue
      }
      const savedPtyIdsByLeafId = layout?.ptyIdsByLeafId
      if (!savedPtyIdsByLeafId) {
        continue
      }
      const liveLeaves = Object.entries(savedPtyIdsByLeafId).filter(
        ([leafId, ptyId]) =>
          typeof ptyId === 'string' &&
          ptyId.length > 0 &&
          isTerminalLeafId(leafId) &&
          (Boolean(getEagerPtyBufferHandle(ptyId)) || parkedWatcherPtyIds.has(ptyId))
      )
      if (liveLeaves.length === 0) {
        continue
      }
      const title = resolveRuntimeTerminalTitle(tab, generatedTitlesEnabled)
      const publishedLeafIds = new Set(liveLeaves.map(([leafId]) => leafId))
      const savedActiveLeafId = layout?.activeLeafId
      const parkedPaneIdsByPtyId = getParkedTerminalWatcherPaneIdsByPtyId(tab.id)
      const parkedPaneTitles = state.runtimePaneTitlesByTabId[tab.id] ?? {}
      graph.tabs.push({
        tabId: tab.id,
        worktreeId,
        title,
        activeLeafId:
          savedActiveLeafId && publishedLeafIds.has(savedActiveLeafId)
            ? savedActiveLeafId
            : liveLeaves[0][0],
        layout: resolveTerminalLayoutRoot({
          authoritativeRoot: layout?.root,
          leafIds: liveLeaves.map(([leafId]) => leafId),
          onSynthesize: (leafCount) =>
            console.warn(
              `[sync-runtime-graph] synthesized layout for ${leafCount} unmounted leaves with no saved tree`
            )
        })
      })
      liveLeaves.forEach(([leafId, ptyId], index) => {
        const parkedPaneId = parkedPaneIdsByPtyId.get(ptyId)
        graph.leaves.push({
          tabId: tab.id,
          worktreeId,
          leafId,
          paneRuntimeId: parkedPaneId ?? index + 1,
          ptyId,
          paneTitle: (parkedPaneId === undefined ? null : parkedPaneTitles[parkedPaneId]) ?? null,
          title
        })
      })
    }
  }

  try {
    const result = await window.api.runtime.syncWindowGraph(graph)
    commitMobileSessionPublication(mobileSessionTabs, result?.mobileSessionResyncWorktrees)
    const currentState = graphState.getStoreState()
    currentState?.setRuntimeAgentOrchestrationByPaneKey?.(result?.agentOrchestrationByPaneKey ?? {})
    for (const resolution of result?.nativeChatLaunchDraftResolutions ?? []) {
      if (currentState) {
        applyNativeChatLaunchDraftResolved(currentState, {
          type: 'nativeChatLaunchDraftResolved',
          ...resolution
        })
      }
    }
    if (result?.mobileSessionResyncWorktrees?.length) {
      scheduleTrailingGraphSync()
    }
  } catch (error) {
    console.error('[runtime] Failed to sync renderer graph:', error)
  }
}

let scheduleTrailingGraphSync: () => void = () => undefined
export function setTrailingGraphSyncScheduler(scheduler: () => void): void {
  scheduleTrailingGraphSync = scheduler
}

function partitionMobileSessionPublication(snapshots: RuntimeMobileSessionTabsSnapshot[]): {
  changed: RuntimeMobileSessionTabsSnapshot[]
  unchangedWorktrees: string[]
} {
  const changed: RuntimeMobileSessionTabsSnapshot[] = []
  const unchangedWorktrees: string[] = []
  for (const snapshot of snapshots) {
    if (graphState.publishedMobileSessionSnapshotByWorktree.get(snapshot.worktree) === snapshot) {
      unchangedWorktrees.push(snapshot.worktree)
    } else {
      changed.push(snapshot)
    }
  }
  return { changed, unchangedWorktrees }
}

function commitMobileSessionPublication(
  snapshots: RuntimeMobileSessionTabsSnapshot[],
  resyncWorktrees: string[] | undefined
): void {
  const published = new Set<string>()
  for (const snapshot of snapshots) {
    published.add(snapshot.worktree)
    graphState.publishedMobileSessionSnapshotByWorktree.set(snapshot.worktree, snapshot)
  }
  for (const worktreeId of graphState.publishedMobileSessionSnapshotByWorktree.keys()) {
    if (!published.has(worktreeId)) {
      graphState.publishedMobileSessionSnapshotByWorktree.delete(worktreeId)
    }
  }
  for (const worktreeId of resyncWorktrees ?? []) {
    graphState.publishedMobileSessionSnapshotByWorktree.delete(worktreeId)
  }
}
