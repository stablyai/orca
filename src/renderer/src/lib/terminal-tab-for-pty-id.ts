import type { AppState } from '@/store/types'

export type TerminalTabPtyOwnershipState = Pick<
  AppState,
  'tabsByWorktree' | 'terminalLayoutsByTabId' | 'ptyIdsByTabId'
>

export type TerminalTabPtyOwnership =
  | { kind: 'owned'; tabId: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' }

/** Tabs binding a ptyId, split by tier: a mounted pane outranks a recorded row. */
export type TerminalTabPtyOwners = { mounted: string[]; recorded: string[] }

type TerminalTabPtyOwnershipOptions = {
  /** Tab id baked into the PTY's env; a fallback and tie-break, not a binding. */
  preferTabId?: string
}

/**
 * Every tab row the store holds, the named worktree's first.
 *
 * Why: terminalLayoutsByTabId and ptyIdsByTabId are keyed by tab id alone, so a
 * binding outlives its row's membership in any one worktree list (STA-7961).
 * A key with no row anywhere is orphan state, not an owner: counting it would
 * make a live PTY look surfaced when nothing can render it.
 */
function listKnownTabIds(state: TerminalTabPtyOwnershipState, worktreeId: string): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  const push = (tabId: string): void => {
    if (!seen.has(tabId)) {
      seen.add(tabId)
      ordered.push(tabId)
    }
  }
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    push(tab.id)
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      push(tab.id)
    }
  }
  return ordered
}

/** tab.ptyId by tab id across every worktree list. */
function collectTabRowPtyIds(state: TerminalTabPtyOwnershipState): Map<string, string> {
  const byTabId = new Map<string, string>()
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.ptyId) {
        byTabId.set(tab.id, tab.ptyId)
      }
    }
  }
  return byTabId
}

function collectOwners(
  state: TerminalTabPtyOwnershipState,
  tabIds: string[],
  ptyId: string
): TerminalTabPtyOwners {
  const rowPtyIds = collectTabRowPtyIds(state)
  const mounted: string[] = []
  const recorded: string[] = []
  for (const tabId of tabIds) {
    if ((state.ptyIdsByTabId[tabId] ?? []).includes(ptyId)) {
      mounted.push(tabId)
      continue
    }
    const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId
    if (
      rowPtyIds.get(tabId) === ptyId ||
      (ptyIdsByLeafId !== undefined && Object.values(ptyIdsByLeafId).includes(ptyId))
    ) {
      recorded.push(tabId)
    }
  }
  return { mounted, recorded }
}

/** Candidate owners of a ptyId across the whole store, event worktree first. */
export function listTerminalTabPtyOwners(
  state: TerminalTabPtyOwnershipState,
  worktreeId: string,
  ptyId: string
): TerminalTabPtyOwners {
  return collectOwners(state, listKnownTabIds(state, worktreeId), ptyId)
}

function tabRowExists(state: TerminalTabPtyOwnershipState, tabId: string): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
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
  const { mounted, recorded } = listTerminalTabPtyOwners(state, worktreeId, ptyId)
  const preferredTabId =
    options.preferTabId !== undefined && tabRowExists(state, options.preferTabId)
      ? options.preferTabId
      : undefined
  const owners = mounted.length > 0 ? mounted : recorded
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

/**
 * Resolve a synthetic mobile handle's ptyId within one worktree; null when
 * unowned or ambiguous. Scoped on purpose: the caller mounts the tab under the
 * requested worktree, so a row filed elsewhere is not a usable answer.
 */
export function resolveTerminalTabIdForPtyId(
  state: TerminalTabPtyOwnershipState,
  worktreeId: string,
  ptyId: string
): string | null {
  const tabIds = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const { mounted, recorded } = collectOwners(state, tabIds, ptyId)
  const owners = mounted.length > 0 ? mounted : recorded
  return owners.length === 1 ? owners[0]! : null
}
