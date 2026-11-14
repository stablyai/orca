import { isTerminalNoticeLifetimeCurrent } from '../../provider-notices/terminal-notice-lifetime'
import { useAppStore } from '@/store/index'
import { sleepingAgentRecordIndex } from '@/store/terminals/sleep/sleeping-agent-record-index'
import { isTerminalLeafId } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { isRemoteExecutionHostPtyId } from '../../../../../../shared/execution-host/remote-execution-host-pty-id'
import { terminalProviderAllowsParking } from '../../../terminal/terminal-provider-snapshot-capability'
import { terminalProviderSessionIsGone } from '../../../terminal/terminal-provider-gone-sessions'
import { isParkRestorableTerminalPty } from '../retention/terminal-hidden-view-parking'
import { selectPairedRuntimeParkingEnvironmentIds } from '../retention/paired-runtime-parking-capabilities'
import {
  capturedPanesByTabId,
  parkedTerminalCaptureRevision
} from './terminal-parked-watcher-registry'
import type { ParkableTerminalTabModel } from './terminal-parked-watcher-reconciliation'
import '../../layout/terminal-layout-leaf-traversal'
import {
  collectLayoutLeafIdsInOrder,
  resolveRootlessTerminalLayoutLeafId
} from '../../../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { ParkedTerminalPaneCapture } from './terminal-parked-watcher-registry'
import { launchAgentTabIds } from './parked-tab-agent-owner-index'

export type ParkedTerminalPtyEligibility = (ptyId: string) => boolean
const allowOrdinaryParkRestore = (ptyId: string): boolean =>
  isRemoteExecutionHostPtyId(ptyId) || terminalProviderAllowsParking(ptyId)

type State = ReturnType<typeof useAppStore.getState>

export function parkRestorePolicyFromState(
  state: Pick<State, 'settings' | 'runtimeStatusByEnvironmentId'>
) {
  return {
    sshParkingEnabled: state.settings?.terminalSshViewParking !== false,
    pairedRuntimeParkingEnvironmentIds: selectPairedRuntimeParkingEnvironmentIds(
      state.runtimeStatusByEnvironmentId
    )
  }
}

type Coverage = {
  inputs: readonly unknown[]
  panes: ReturnType<typeof resolveParkedTerminalPaneCandidates>
}
const coverageByTab = new WeakMap<ParkableTerminalTabModel, Coverage>()

/** Share pane facts, never a policy-independent boolean: activation and ordinary parking admit different routes. */
export function parkedTerminalTabCoverage(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  state: State = useAppStore.getState()
) {
  const inputs = [
    worktreeId,
    tab.ptyId,
    state.terminalLayoutsByTabId[tab.id],
    state.ptyIdsByTabId?.[tab.id],
    state.lastKnownRelayPtyIdByTabId?.[tab.id],
    state.runtimePaneTitlesByTabId[tab.id],
    capturedPanesByTabId.get(tab.id),
    parkedTerminalCaptureRevision(tab.id)
  ]
  const previous = coverageByTab.get(tab)
  const facts =
    previous && inputs.every((input, index) => input === previous.inputs[index])
      ? previous
      : { inputs, panes: resolveParkedTerminalPaneCandidates(tab, state) }
  if (facts !== previous) {
    coverageByTab.set(tab, facts)
  }
  return { panes: facts.panes, restorePolicy: parkRestorePolicyFromState(state) }
}

function goneSessionsKeepTabMounted(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  facts: ReturnType<typeof parkedTerminalTabCoverage>
): boolean {
  const goneCount = facts.panes.filter(
    (pane) => pane.ptyId !== null && terminalProviderSessionIsGone(pane.ptyId)
  ).length
  if (goneCount === 0) {
    return false
  }
  const state = useAppStore.getState()
  return (
    goneCount < facts.panes.length ||
    launchAgentTabIds(state.tabsByWorktree[worktreeId]).has(tab.id) ||
    sleepingAgentRecordIndex.hasTabPrefix(state.sleepingAgentSessionsByPaneKey, tab.id)
  )
}

export function canWatcherCoverParkedTerminalTab(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  isPtyEligible: ParkedTerminalPtyEligibility = allowOrdinaryParkRestore
): boolean {
  const facts = parkedTerminalTabCoverage(worktreeId, tab)
  return (
    facts.panes.length > 0 &&
    facts.panes.every(
      (pane) =>
        pane.ptyId !== null &&
        isTerminalLeafId(pane.leafId) &&
        isParkRestorableTerminalPty(pane.ptyId, worktreeId, facts.restorePolicy) &&
        isPtyEligible(pane.ptyId)
    ) &&
    !goneSessionsKeepTabMounted(worktreeId, tab, facts)
  )
}

type ParkedPaneFallbackState = {
  terminalLayoutsByTabId: ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
  runtimePaneTitlesByTabId: ReturnType<typeof useAppStore.getState>['runtimePaneTitlesByTabId']
}

function fallbackParkedPaneCandidates(
  tab: ParkableTerminalTabModel,
  state: ParkedPaneFallbackState
): ParkedTerminalPaneCapture[] {
  const layout = state.terminalLayoutsByTabId[tab.id]
  const rootLeafIds = collectLayoutLeafIdsInOrder(layout?.root)
  const rootlessLeafId = layout ? resolveRootlessTerminalLayoutLeafId(layout) : null
  const leafIds =
    rootLeafIds.length > 0 ? rootLeafIds : rootlessLeafId !== null ? [rootlessLeafId] : []
  if (leafIds.length === 0) {
    return []
  }
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId ?? {}
  const titleSlots = Object.keys(state.runtimePaneTitlesByTabId[tab.id] ?? {})
  const reusableSlot =
    leafIds.length === 1 && titleSlots.length === 1 ? Number(titleSlots[0]) : null
  return leafIds.map((leafId, index) => ({
    ptyId: ptyIdsByLeafId[leafId] ?? (leafIds.length === 1 ? tab.ptyId : null),
    paneId: reusableSlot ?? -(index + 1),
    leafId,
    drivesTabTitle: layout?.activeLeafId ? leafId === layout.activeLeafId : index === 0
  }))
}

function leafPtyKey(leafId: string, ptyId: string | null): string {
  return `${leafId}\u0000${ptyId ?? ''}\u0000${ptyId === null ? 0 : 1}`
}

// Index captured panes so a many-split tab stays linear in its pane count.
function capturedCoversFallback(
  captured: readonly ParkedTerminalPaneCapture[],
  fallback: readonly ParkedTerminalPaneCapture[]
): boolean {
  const capturedLeafPtyKeys = new Set(
    captured.map((candidate) => leafPtyKey(candidate.leafId, candidate.ptyId))
  )
  return fallback.every((pane) => capturedLeafPtyKeys.has(leafPtyKey(pane.leafId, pane.ptyId)))
}

function resolveParkedTerminalPaneCandidates(
  tab: ParkableTerminalTabModel,
  state: ParkedPaneFallbackState
): ParkedTerminalPaneCapture[] {
  const captured = capturedPanesByTabId.get(tab.id)
  const fallback = fallbackParkedPaneCandidates(tab, state)
  if (!captured) {
    return fallback
  }
  const capturedIsCurrent =
    captured.panes.length > 0 &&
    (tab.ptyId === null || captured.panes.some((pane) => pane.ptyId === tab.ptyId)) &&
    (fallback.length === 0 ||
      (captured.panes.length === fallback.length &&
        capturedCoversFallback(captured.panes, fallback)))
  if (capturedIsCurrent) {
    return captured.panes
  }
  if (fallback.length === 0) {
    return fallback
  }
  const priorByLeafId = new Map<string, ParkedTerminalPaneCapture>()
  for (const candidate of captured.panes) {
    if (!priorByLeafId.has(candidate.leafId)) {
      priorByLeafId.set(candidate.leafId, candidate)
    }
  }
  return fallback.map((pane) => {
    const prior = priorByLeafId.get(pane.leafId)
    return prior
      ? {
          ...pane,
          paneId: prior.paneId,
          ...(prior.noticeLifetime?.ptyId === pane.ptyId &&
          isTerminalNoticeLifetimeCurrent(prior.noticeLifetime)
            ? { noticeLifetime: prior.noticeLifetime }
            : {}),
          ...(prior.ptyId === pane.ptyId && prior.workspaceOwner
            ? { workspaceOwner: prior.workspaceOwner }
            : {}),
          drivesTabTitle: prior.drivesTabTitle,
          // Why: the fact belongs to the captured PTY; a re-minted id on this leaf is a different shell.
          ...(prior.ptyId === pane.ptyId && prior.untouchedFreshSpawn
            ? { untouchedFreshSpawn: true }
            : {})
        }
      : pane
  })
}
