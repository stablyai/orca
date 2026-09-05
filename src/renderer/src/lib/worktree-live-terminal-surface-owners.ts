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
 * Three verdicts, never two: an entry is the owner, a `null` entry is
 * `unverifiable` (the host named a surface this renderer cannot address, or
 * named two), and a whole-index `null` is `unverifiable` for every PTY. Absence
 * from a readable index is the only proof of `unowned`.
 */
export type LiveTerminalSurfaceOwnerIndex = ReadonlyMap<string, LiveTerminalSurfaceOwner | null>

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
): Map<string, LiveTerminalSurfaceOwner | null> {
  const owners = new Map<string, LiveTerminalSurfaceOwner | null>()
  for (const terminal of terminals) {
    // `orphaned` is the host's own word for "live PTY, no surface owns it".
    // Path spelling can differ between the host's row and the renderer's id; dropping a row
    // over that would read as `unowned` and mint the duplicate this index exists to prevent.
    if (
      !worktreeIdsEqual(terminal.worktreeId, worktreeId) ||
      !terminal.ptyId ||
      terminal.orphaned === true
    ) {
      continue
    }
    const owner = toSurfaceOwner(terminal)
    const recorded = owners.get(terminal.ptyId)
    // Two surfaces claiming one PTY is the duplicate this index must not endorse.
    owners.set(
      terminal.ptyId,
      owners.has(terminal.ptyId) && recorded?.paneKey !== owner?.paneKey ? null : owner
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
