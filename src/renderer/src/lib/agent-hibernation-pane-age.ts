import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'

type PtyBinding = { ptyId: string; firstSeenAt: number; lastSeenAt: number }

const ptyBindingByPaneKey = new Map<string, PtyBinding>()
const boundaryResolvedAtByPaneKey = new Map<string, number>()

/** Floor idle time at the current PTY binding’s age: main persists ancient stateStartedAt across wakes/restarts, so replay alone must not immediately hibernate a fresh pane. */
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
  // Layout gaps already fail closed; retain binding age until authoritative removal or expiry to avoid repeated grace resets.
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
    // Closed splits reopen with fresh leaf IDs; expire boundary stamps with retained bindings to avoid a lifetime leak.
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

/** Stamp the real completion boundary synchronously; a 60s coordinator sample could miss a boundary written and cleared between ticks. */
export function recordHibernationBoundaryResolved(paneKey: string, now: number): void {
  if (paneKey) {
    boundaryResolvedAtByPaneKey.set(paneKey, now)
  }
}

export function getHibernationBoundaryResolvedAtByPaneKey(): Record<string, number> {
  return Object.fromEntries(boundaryResolvedAtByPaneKey)
}

export function resetHibernationPaneAgeForTests(): void {
  ptyBindingByPaneKey.clear()
  boundaryResolvedAtByPaneKey.clear()
}
