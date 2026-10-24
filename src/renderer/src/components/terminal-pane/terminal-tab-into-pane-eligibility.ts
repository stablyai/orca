import type { AppState } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { isWebClientLocation } from '@/lib/web-client-location'
import { isHostAuthoritativeLayout } from './terminal-live-layout-reconciliation'
import { isTerminalLeafMoveInFlight, isTerminalTabMoveInFlight } from './terminal-leaf-move-guard'

export type TerminalTabIntoPaneState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'pendingStartupByTabId'
  | 'automaticAgentResumeClaimsByTabId'
  | 'pendingInitialCwdByTabId'
  | 'pendingIssueCommandSplitByTabId'
  | 'unverifiedPtyLossTabIds'
  | 'sleepingAgentSessionsByPaneKey'
  | 'pendingPtyShutdownIds'
>

export type TerminalTabIntoPaneRefusal =
  | 'layout_owner_build'
  | 'same_tab'
  | 'source_missing'
  | 'target_missing'
  | 'worktree_mismatch'
  | 'source_not_single_pane'
  | 'source_chat'
  | 'target_chat'
  | 'target_pane_missing'
  | 'no_terminal'
  | 'pending_spawn'
  | 'launch_pending'
  | 'sleeping'
  | 'pty_exiting'
  | 'startup_pending'
  | 'unverified_pty_loss'
  | 'host_authoritative'
  | 'move_in_flight'

export type TerminalTabIntoPaneEligibility =
  | { ok: true; worktreeId: string; leafId: string; ptyId: string; targetLeafId: string }
  | { ok: false; reason: TerminalTabIntoPaneRefusal }

const SOURCE_WIDE_REFUSALS: ReadonlySet<TerminalTabIntoPaneRefusal> = new Set([
  'layout_owner_build',
  'source_missing',
  'source_not_single_pane',
  'source_chat',
  'no_terminal',
  'pending_spawn',
  'launch_pending',
  'sleeping',
  'pty_exiting',
  'startup_pending',
  'unverified_pty_loss'
])

/** Whether the refusal comes from the source tab alone, so it would repeat on every target. */
export function isSourceWideRefusal(reason: TerminalTabIntoPaneRefusal): boolean {
  return SOURCE_WIDE_REFUSALS.has(reason)
}

function findTab(state: TerminalTabIntoPaneState, tabId: string): TerminalTab | undefined {
  return Object.values(state.tabsByWorktree)
    .flat()
    .find((tab) => tab.id === tabId)
}

function hasQueuedTabWork(state: TerminalTabIntoPaneState, tabId: string): boolean {
  // closeTab drops each of these with the tab, so a move would silently lose the queued work.
  return [
    state.pendingStartupByTabId,
    state.automaticAgentResumeClaimsByTabId,
    state.pendingInitialCwdByTabId,
    state.pendingIssueCommandSplitByTabId
  ].some((byTabId) => tabId in byTabId)
}

function layoutLeaves(layout: TerminalLayoutSnapshot | undefined): {
  several: boolean
  only: string | null
} {
  const leafIds = collectLayoutLeafIdsInOrder(layout?.root ?? null)
  return { several: leafIds.length > 1, only: leafIds.length === 1 ? (leafIds[0] ?? null) : null }
}

/**
 * Whether the single-pane tab `sourceTabId` may join `targetTabId`'s pane. Pure over the store, so
 * the menu can disable an entry with its reason and the move can recheck at the moment it runs.
 * Main re-checks what it can see; the checks here are the renderer-only ones it cannot.
 */
export function resolveTerminalTabIntoPaneEligibility(
  state: TerminalTabIntoPaneState,
  args: {
    sourceTabId: string
    targetTabId: string
    targetLeafId?: string | null
    isWebClient?: boolean
  }
): TerminalTabIntoPaneEligibility {
  const { sourceTabId, targetTabId } = args
  const refuse = (reason: TerminalTabIntoPaneRefusal): TerminalTabIntoPaneEligibility => ({
    ok: false,
    reason
  })
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    // Layout-owner builds draw moves from main's frames; this window-applied join would land twice.
    return refuse('layout_owner_build')
  }
  if (sourceTabId === targetTabId) {
    return refuse('same_tab')
  }
  const source = findTab(state, sourceTabId)
  const target = findTab(state, targetTabId)
  if (!source) {
    return refuse('source_missing')
  }
  if (!target) {
    return refuse('target_missing')
  }
  if (source.worktreeId !== target.worktreeId) {
    return refuse('worktree_mismatch')
  }
  const sourceLayout = state.terminalLayoutsByTabId[sourceTabId]
  const targetLayout = state.terminalLayoutsByTabId[targetTabId]
  const { several, only: leafId } = layoutLeaves(sourceLayout)
  if (several) {
    return refuse('source_not_single_pane')
  }
  if (source.viewMode === 'chat' || (leafId && sourceLayout?.chatLeafId === leafId)) {
    return refuse('source_chat')
  }
  const ptyId = leafId ? (sourceLayout?.ptyIdsByLeafId?.[leafId] ?? source.ptyId) : null
  if (!leafId || !ptyId) {
    return refuse('no_terminal')
  }
  const isWebClient = args.isWebClient ?? isWebClientLocation()
  if (
    isHostAuthoritativeLayout({
      isWebClient,
      ptyIdsByLeafId: { ...sourceLayout?.ptyIdsByLeafId, [leafId]: ptyId }
    }) ||
    isHostAuthoritativeLayout({ isWebClient, ptyIdsByLeafId: targetLayout?.ptyIdsByLeafId })
  ) {
    return refuse('host_authoritative')
  }
  if (source.pendingActivationSpawn) {
    return refuse('pending_spawn')
  }
  if (source.agentLaunchPane?.leafId === leafId && !source.agentLaunchPane.outcome) {
    return refuse('launch_pending')
  }
  if (makePaneKey(sourceTabId, leafId) in state.sleepingAgentSessionsByPaneKey) {
    return refuse('sleeping')
  }
  if (state.pendingPtyShutdownIds[ptyId]) {
    return refuse('pty_exiting')
  }
  if (hasQueuedTabWork(state, sourceTabId)) {
    return refuse('startup_pending')
  }
  if (sourceTabId in state.unverifiedPtyLossTabIds) {
    return refuse('unverified_pty_loss')
  }
  // After every source-only check, so an ineligible source reads the same over any target.
  if (target.viewMode === 'chat') {
    return refuse('target_chat')
  }
  const targetLeafIds = collectLayoutLeafIdsInOrder(targetLayout?.root ?? null)
  const targetLeafId =
    args.targetLeafId ??
    (targetLayout?.activeLeafId && targetLeafIds.includes(targetLayout.activeLeafId)
      ? targetLayout.activeLeafId
      : targetLeafIds[0])
  if (!targetLeafId || !targetLeafIds.includes(targetLeafId)) {
    return refuse('target_pane_missing')
  }
  if (
    isTerminalLeafMoveInFlight(leafId) ||
    isTerminalTabMoveInFlight(sourceTabId) ||
    isTerminalTabMoveInFlight(targetTabId)
  ) {
    return refuse('move_in_flight')
  }
  return { ok: true, worktreeId: source.worktreeId, leafId, ptyId, targetLeafId }
}
