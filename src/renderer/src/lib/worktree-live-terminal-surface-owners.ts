import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
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
 * ptyId → owning surface, as the execution host records it. The renderer's own
 * binding maps are a projection that hydration, a second window, or a
 * client-created tab can leave empty, so they cannot answer "is this PTY
 * unowned?" — only the host can.
 *
 * Only `unowned` proves the host observed a live PTY with no surface. Null and
 * missing entries are unverifiable; an earlier inventory may name a retired PTY.
 */
type LiveTerminalSurfaceOwnership = LiveTerminalSurfaceOwner | 'unowned' | null
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

export function indexLiveTerminalSurfaceOwners(
  terminals: readonly RuntimeTerminalSummary[],
  worktreeId: string
): Map<string, LiveTerminalSurfaceOwnership> {
  const owners = new Map<string, LiveTerminalSurfaceOwnership>()
  for (const terminal of terminals) {
    if (!worktreeIdsEqual(terminal.worktreeId, worktreeId) || !terminal.ptyId) {
      continue
    }
    const owner =
      terminal.orphaned === true
        ? terminal.connected === true
          ? 'unowned'
          : null
        : toSurfaceOwner(terminal)
    const recorded = owners.get(terminal.ptyId)
    const recordedPane = recorded && recorded !== 'unowned' ? recorded.paneKey : recorded
    const ownerPane = owner && owner !== 'unowned' ? owner.paneKey : owner
    // Conflicting ownership claims cannot authorize adoption.
    owners.set(
      terminal.ptyId,
      owners.has(terminal.ptyId) && recordedPane !== ownerPane ? null : owner
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
