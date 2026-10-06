import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  listTerminalTabPtyOwners,
  resolveTerminalTabPtyOwnership,
  type TerminalTabPtyOwnershipState
} from './terminal-tab-for-pty-id'

export type TerminalRevealTabAdoption =
  | { kind: 'adopt'; tabId: string; via: 'pty-owner' | 'bound-leaf' | 'ambiguity-tiebreak' }
  | { kind: 'mint'; verdict: 'none' | 'ambiguous' }

export type TerminalRevealTabRequest = {
  worktreeId: string
  ptyId: string
  leafId?: string
  /** Tab id baked into the PTY's env when it spawned; a hint, not a binding. */
  hintTabId?: string
}

/**
 * The tab whose layout owns a leaf id. A leaf id names one pane for its lifetime,
 * and layouts are keyed by tab id alone, so this answer is independent of which
 * worktree list the owning row currently sits in. A tab that binds the leaf to a
 * PTY outranks one that merely carries it in its tree: the hydration self-heal
 * leaves a losing single-leaf tab holding the id unbound, and that tab has no
 * session to adopt. Within a tier the first tab found wins.
 */
export function findTerminalTabIdBindingLeafId(
  state: Pick<AppState, 'terminalLayoutsByTabId'>,
  leafId: string
): string | null {
  let rootOnlyTabId: string | null = null
  for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    if (layout === undefined) {
      continue
    }
    const inRoot = layout.root ? collectLeafIdsInOrder(layout.root).includes(leafId) : false
    // Why the root test: detaching a pane can strand a binding whose leaf the tree no longer
    // holds, and a stranded entry mounts nothing, so it must not outrank a layout that does.
    if (layout.ptyIdsByLeafId?.[leafId] !== undefined && (inRoot || !layout.root)) {
      return tabId
    }
    if (inRoot && rootOnlyTabId === null) {
      rootOnlyTabId = tabId
    }
  }
  return rootOnlyTabId
}

/** Locate a tab row and the worktree key it is filed under, across every key. */
export function findTerminalTabRow(
  state: Pick<AppState, 'tabsByWorktree'>,
  tabId: string
): { tab: TerminalTab; worktreeId: string } | null {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (tab) {
      return { tab, worktreeId }
    }
  }
  return null
}

/**
 * Decide which tab a terminal reveal belongs to. Minting is the last resort:
 * a second tab bound to a live PTY mounts the same session twice, and the
 * single-slot data handler then starves one of the two panes (STA-7961).
 */
export function resolveTerminalRevealTabAdoption(
  state: TerminalTabPtyOwnershipState,
  request: TerminalRevealTabRequest
): TerminalRevealTabAdoption {
  const ownership = resolveTerminalTabPtyOwnership(
    state,
    request.worktreeId,
    request.ptyId,
    request.hintTabId !== undefined ? { preferTabId: request.hintTabId } : {}
  )
  if (ownership.kind === 'owned') {
    return { kind: 'adopt', tabId: ownership.tabId, via: 'pty-owner' }
  }
  // Why: re-minting a bound leaf id hands two tabs the same pane identity even
  // when the reveal's pty id is unowned or stale.
  const leafOwnerTabId = request.leafId
    ? findTerminalTabIdBindingLeafId(state, request.leafId)
    : null
  if (leafOwnerTabId !== null) {
    return { kind: 'adopt', tabId: leafOwnerTabId, via: 'bound-leaf' }
  }
  if (ownership.kind === 'ambiguous') {
    const owners = listTerminalTabPtyOwners(state, request.worktreeId, request.ptyId)
    // The hint already won upstream if it named an owner, so take the strongest tier.
    const fallbackTabId = owners.mounted[0] ?? owners.recorded[0]
    if (fallbackTabId !== undefined) {
      const candidates = [...owners.mounted, ...owners.recorded].join(', ')
      console.warn(
        `[onCreateTerminal] ptyId ${request.ptyId} is claimed by ${candidates};` +
          ` attaching to ${fallbackTabId} rather than minting a second tab for it`
      )
      return { kind: 'adopt', tabId: fallbackTabId, via: 'ambiguity-tiebreak' }
    }
  }
  return { kind: 'mint', verdict: ownership.kind }
}
