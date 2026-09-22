import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'

type PtyBinding = { ptyId: string; firstSeenAt: number; lastSeenAt: number }

const ptyBindingByPaneKey = new Map<string, PtyBinding>()
const boundaryResolvedAtByPaneKey = new Map<string, number>()

/**
 * Floors the hibernation idle clock at the age of a pane's current PTY binding.
 *
 * Why: `dropHibernatedAgentStatusPane` never notifies main, and main's
 * `lastStatusByPaneKey` is persisted — so a woken or post-restart pane replays an
 * ancient `stateStartedAt` and is instantly past the idle window. A wake spawns a
 * fresh PTY and an app launch starts this map empty, so binding age restores the
 * grace `updatedAt` used to provide by accident.
 */
export function observeHibernationPtyBindings(args: {
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  now: number
  idleMs: number
}): void {
  const liveTabIds = new Set<string>()
  for (const tabs of Object.values(args.tabsByWorktree)) {
    for (const tab of tabs) {
      liveTabIds.add(tab.id)
    }
  }
  const seenPaneKeys = new Set<string>()
  for (const tabId of liveTabIds) {
    const ptyIdsByLeafId = args.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId
    for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId ?? {})) {
      if (!ptyId) {
        continue
      }
      let paneKey: string
      try {
        paneKey = makePaneKey(tabId, leafId)
      } catch {
        continue
      }
      seenPaneKeys.add(paneKey)
      const existing = ptyBindingByPaneKey.get(paneKey)
      if (existing && existing.ptyId === ptyId) {
        existing.lastSeenAt = args.now
      } else {
        ptyBindingByPaneKey.set(paneKey, { ptyId, firstSeenAt: args.now, lastSeenAt: args.now })
      }
    }
  }
  // Why: a transient layout gap already makes the planner fail closed, so dropping
  // the binding there would hand the same PTY a fresh idle window on reappearance.
  // Retain unseen entries; expire only on authoritative tab removal or by age.
  for (const [paneKey, binding] of ptyBindingByPaneKey) {
    if (seenPaneKeys.has(paneKey)) {
      continue
    }
    const tabId = paneKey.slice(0, paneKey.indexOf(':'))
    if (!liveTabIds.has(tabId) || args.now - binding.lastSeenAt > args.idleMs) {
      ptyBindingByPaneKey.delete(paneKey)
    }
  }
  for (const paneKey of boundaryResolvedAtByPaneKey.keys()) {
    const tabId = paneKey.slice(0, paneKey.indexOf(':'))
    // Why: closed split panes mint fresh leaf ids when reopened. Once their
    // retained binding expires, keeping the boundary stamp would leak one map
    // entry per closed pane for the renderer's lifetime.
    if (!liveTabIds.has(tabId) || !ptyBindingByPaneKey.has(paneKey)) {
      boundaryResolvedAtByPaneKey.delete(paneKey)
    }
  }
}

export function getHibernationPtyBindingFirstSeenAtByPaneKey(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [paneKey, binding] of ptyBindingByPaneKey) {
    out[paneKey] = binding.firstSeenAt
  }
  return out
}

/**
 * Stamped synchronously by the status store when a session-boundary `done` turns
 * into a real completion. Sampling this on the 60s coordinator tick would miss a
 * boundary written and cleared between two samples, leaving the pane on its
 * ancient anchor.
 */
export function recordHibernationBoundaryResolved(paneKey: string, now: number): void {
  if (paneKey) {
    boundaryResolvedAtByPaneKey.set(paneKey, now)
  }
}

export function getHibernationBoundaryResolvedAtByPaneKey(): Record<string, number> {
  return Object.fromEntries(boundaryResolvedAtByPaneKey)
}

export function forgetHibernationPaneAge(paneKey: string): void {
  ptyBindingByPaneKey.delete(paneKey)
  boundaryResolvedAtByPaneKey.delete(paneKey)
}

export function resetHibernationPaneAgeForTests(): void {
  ptyBindingByPaneKey.clear()
  boundaryResolvedAtByPaneKey.clear()
}
