import type { AppState } from '@/store/types'

export type TerminalTabPtyOwnershipState = Pick<
  AppState,
  'tabsByWorktree' | 'terminalLayoutsByTabId' | 'ptyIdsByTabId'
>

export type TerminalTabPtyOwnership =
  | { kind: 'owned'; tabId: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' }

type TerminalTabPtyOwnershipOptions = {
  /** Tab id baked into the PTY's env; a fallback and tie-break, not a binding. */
  preferTabId?: string
}

/**
 * Resolve which tab owns a ptyId. Every binding below is an exact match on the
 * id, so any of them beats the caller's tab hint: that hint is written once when
 * the PTY spawns and goes stale as soon as a pane moves between tabs. A mounted
 * pane outranks a recorded one, and same-tier conflicts stay ambiguous.
 */
export function resolveTerminalTabPtyOwnership(
  state: TerminalTabPtyOwnershipState,
  worktreeId: string,
  ptyId: string,
  options: TerminalTabPtyOwnershipOptions = {}
): TerminalTabPtyOwnership {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const mountedOwners: string[] = []
  const recordedOwners: string[] = []
  for (const tab of tabs) {
    if ((state.ptyIdsByTabId[tab.id] ?? []).includes(ptyId)) {
      mountedOwners.push(tab.id)
      continue
    }
    const ptyIdsByLeafId = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId
    if (
      tab.ptyId === ptyId ||
      (ptyIdsByLeafId !== undefined && Object.values(ptyIdsByLeafId).includes(ptyId))
    ) {
      recordedOwners.push(tab.id)
    }
  }
  const preferredTabId =
    options.preferTabId !== undefined && tabs.some((tab) => tab.id === options.preferTabId)
      ? options.preferTabId
      : undefined
  const owners = mountedOwners.length > 0 ? mountedOwners : recordedOwners
  if (owners.length === 1) {
    return { kind: 'owned', tabId: owners[0]! }
  }
  if (owners.length > 1) {
    // Why: stale duplicate ownership must not attach whichever hidden tab
    // happens to appear first in persisted order.
    return preferredTabId !== undefined && owners.includes(preferredTabId)
      ? { kind: 'owned', tabId: preferredTabId }
      : { kind: 'ambiguous' }
  }
  // Why: nothing records the PTY yet, so the tab it was minted against is the
  // only thing left that keeps paneKey hook attribution intact (#10486).
  return preferredTabId !== undefined ? { kind: 'owned', tabId: preferredTabId } : { kind: 'none' }
}

/** Resolve a synthetic mobile handle's ptyId; null when unowned or ambiguous. */
export function resolveTerminalTabIdForPtyId(
  state: TerminalTabPtyOwnershipState,
  worktreeId: string,
  ptyId: string
): string | null {
  const ownership = resolveTerminalTabPtyOwnership(state, worktreeId, ptyId)
  return ownership.kind === 'owned' ? ownership.tabId : null
}
