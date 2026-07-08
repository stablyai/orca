// STA-1282: pure-ish store-reading helpers for the eviction coordinator, split
// out to keep the coordinator focused. These resolve the messy store facts into
// the clean policy inputs and the change-detection signature.

import type { useAppStore } from '@/store'
import {
  isTerminalPaneEvictionEnabled,
  resolveTerminalPaneEvictionAfterMs,
  resolveTerminalPaneEvictionWarmBudget
} from '../../../../shared/terminal-pane-eviction-settings'
import type { PaneMountCandidate, PaneMountPolicyInput } from './pane-mount-policy'
import { forEachParkedOwner, isEvictionSelfDisabled, isTabParked } from './evicted-pane-registry'

type StoreState = ReturnType<typeof useAppStore.getState>

export type EvictionCoordinatorContext = {
  managedTabs: ReadonlyMap<string, { worktreeId: string }>
  lastVisibleAt: ReadonlyMap<string, number>
  visibleTabIds: ReadonlySet<string>
}

export function buildEvictionCandidates(
  state: StoreState,
  ctx: EvictionCoordinatorContext
): PaneMountCandidate[] {
  const candidates: PaneMountCandidate[] = []
  for (const [tabId, { worktreeId }] of ctx.managedTabs) {
    const ptyIds = state.ptyIdsByTabId[tabId] ?? []
    const hasWakeHint = ptyIds.some((id) => state.suppressedPtyExitIds[id])
    candidates.push({
      tabId,
      worktreeId,
      isVisible: ctx.visibleTabIds.has(tabId),
      lastVisibleAt: ctx.lastVisibleAt.get(tabId) ?? null,
      // No bound PTY yet = newborn/dead (both exempt: keep today's behavior).
      ptyState: ptyIds.length > 0 ? 'live' : 'newborn',
      hasWakeHint,
      isParked: isTabParked(tabId)
    })
  }
  return candidates
}

export function buildEvictionPolicyInput(
  state: StoreState,
  ctx: EvictionCoordinatorContext
): PaneMountPolicyInput {
  return {
    candidates: buildEvictionCandidates(state, ctx),
    nowMs: Date.now(),
    evictionEnabled: isTerminalPaneEvictionEnabled(state.settings) && !isEvictionSelfDisabled(),
    warmBudget: resolveTerminalPaneEvictionWarmBudget(state.settings),
    evictAfterMs: resolveTerminalPaneEvictionAfterMs(state.settings)
  }
}

/**
 * Cheap change-detector so the store subscription only recomputes when an
 * eviction input actually moved (selection / PTY bind-exit / wake / settings),
 * not on every unrelated store tick (e.g. hot PTY output).
 */
export function computeEvictionInputSignature(
  state: StoreState,
  managedTabs: ReadonlyMap<string, { worktreeId: string }>
): string {
  const parts: string[] = [
    state.activeWorktreeId ?? '',
    state.activeTabId ?? '',
    state.activeView ?? ''
  ]
  for (const tabId of managedTabs.keys()) {
    const ptyIds = state.ptyIdsByTabId[tabId] ?? []
    const wake = ptyIds.some((id) => state.suppressedPtyExitIds[id]) ? '1' : '0'
    parts.push(`${tabId}:${ptyIds.join(',')}:${wake}`)
  }
  // Gate #8: parked (evicted) tabs are not in managedTabs, so a background parked
  // tab or its worktree closing would otherwise not move the signature and the
  // registry close-reconcile would only fire on the next unrelated event. Fold
  // each parked owner's tab/worktree liveness in so the close is detected promptly.
  forEachParkedOwner((tabId, worktreeId) => {
    const tabAlive = state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId) ? '1' : '0'
    const worktreeAlive = state.tabsByWorktree[worktreeId] !== undefined ? '1' : '0'
    parts.push(`p:${worktreeId}:${tabId}:${tabAlive}${worktreeAlive}`)
  })
  const settings = state.settings
  parts.push(
    `${settings?.experimentalTerminalPaneEviction ?? ''}:${settings?.terminalPaneEvictionWarmBudget ?? ''}:${settings?.terminalPaneEvictionAfterMinutes ?? ''}`
  )
  return parts.join('|')
}

/** Live tab/worktree ids for the parked-registry close-reconcile (gate #8). */
export function collectLiveTabAndWorktreeIds(state: StoreState): {
  tabIds: Set<string>
  worktreeIds: Set<string>
} {
  const tabIds = new Set<string>()
  const worktreeIds = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    worktreeIds.add(worktreeId)
    for (const tab of tabs) {
      tabIds.add(tab.id)
    }
  }
  return { tabIds, worktreeIds }
}

export function shallowEqualBooleanMap(
  a: Record<string, boolean>,
  b: Record<string, boolean>
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) {
    return false
  }
  return aKeys.every((key) => a[key] === b[key])
}
