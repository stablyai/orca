import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import type {
  RuntimeTerminalListHostScope,
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

/** The exact surface the execution host records as owning a live PTY. */
export type LiveTerminalSurfaceOwner = {
  paneKey: string
  ptyId: string
  tabId: string
}

/**
 * The host observed a live PTY with no surface. `recorded` is the pane its record last named: the
 * host's graph only carries mounted or provably live panes, so this renderer may still hold it.
 */
export type UnownedLiveTerminal = { unowned: true; recorded: LiveTerminalSurfaceOwner | null }

/**
 * ptyId → owning surface, as the execution host records it. The renderer's own
 * binding maps are a projection that hydration, a second window, or a
 * client-created tab can leave empty, so they cannot answer "is this PTY
 * unowned?" — only the host can.
 *
 * Only an `UnownedLiveTerminal` proves the host observed a live PTY with no surface. Null and
 * missing entries are unverifiable; an earlier inventory may name a retired PTY.
 */
type LiveTerminalSurfaceOwnership = LiveTerminalSurfaceOwner | UnownedLiveTerminal | null
export type LiveTerminalSurfaceOwnerIndex = ReadonlyMap<string, LiveTerminalSurfaceOwnership>

const OWNER_LISTING_LIMIT = 200

/** A host that predates `hostScope` cannot say what it answered for, so it cannot be read. */
function isScopedTerminalListResult(
  value: unknown
): value is RuntimeTerminalListResult & { hostScope: RuntimeTerminalListHostScope } {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { terminals?: unknown }).terminals)
  ) {
    return false
  }
  const hostScope = (value as { hostScope?: unknown }).hostScope
  return (
    Boolean(hostScope) &&
    typeof hostScope === 'object' &&
    Array.isArray((hostScope as { hostIds?: unknown }).hostIds) &&
    Array.isArray((hostScope as { omittedHostIds?: unknown }).omittedHostIds)
  )
}

function toSurfaceOwner(terminal: RuntimeTerminalSummary): LiveTerminalSurfaceOwner | null {
  if (!terminal.ptyId || !terminal.tabId || terminal.tabId.includes(':')) {
    return null
  }
  return isTerminalLeafId(terminal.leafId)
    ? {
        paneKey: makePaneKey(terminal.tabId, terminal.leafId),
        ptyId: terminal.ptyId,
        tabId: terminal.tabId
      }
    : null
}

function toRecordedSurface(terminal: RuntimeTerminalSummary): LiveTerminalSurfaceOwner | null {
  const pane = parsePaneKey(terminal.recordedPaneKey ?? '')
  return terminal.ptyId && pane
    ? { paneKey: makePaneKey(pane.tabId, pane.leafId), ptyId: terminal.ptyId, tabId: pane.tabId }
    : null
}

function ownershipPaneKey(ownership: LiveTerminalSurfaceOwnership | undefined): string | null {
  if (!ownership) {
    return null
  }
  return 'unowned' in ownership ? 'unowned' : ownership.paneKey
}

export function indexLiveTerminalSurfaceOwners(
  terminals: readonly RuntimeTerminalSummary[],
  worktreeId: string
): Map<string, LiveTerminalSurfaceOwnership> {
  const owners = new Map<string, LiveTerminalSurfaceOwnership>()
  for (const terminal of terminals) {
    if (!worktreeIdsEqual(terminal.worktreeId, worktreeId) || !terminal.ptyId) {
      continue
    }
    const owner: LiveTerminalSurfaceOwnership =
      terminal.orphaned === true
        ? terminal.connected === true
          ? { unowned: true, recorded: toRecordedSurface(terminal) }
          : null
        : toSurfaceOwner(terminal)
    // Conflicting ownership claims cannot authorize adoption.
    owners.set(
      terminal.ptyId,
      owners.has(terminal.ptyId) &&
        ownershipPaneKey(owners.get(terminal.ptyId)) !== ownershipPaneKey(owner)
        ? null
        : owner
    )
  }
  return owners
}

/**
 * Reads the local execution host's census. Null when it could not produce a
 * complete one for the workspace.
 */
export async function readWorktreeLiveTerminalSurfaceOwners(
  worktreeId: string
): Promise<LiveTerminalSurfaceOwnerIndex | null> {
  if (typeof window === 'undefined') {
    return null
  }
  const response = await window.api.runtime.call({
    method: 'terminal.list',
    params: {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      limit: OWNER_LISTING_LIMIT,
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    }
  })
  if (!response.ok || !isScopedTerminalListResult(response.result)) {
    return null
  }
  const { hostScope, terminals, truncated } = response.result
  // A worktree-scoped listing names every host but the target's as omitted by
  // design, so completeness here is "the workspace's own host answered" —
  // `hostIds` holds exactly that host when it did. A truncated list never proves
  // any PTY unowned.
  return truncated === true || hostScope.hostIds.length === 0
    ? null
    : indexLiveTerminalSurfaceOwners(terminals, worktreeId)
}
