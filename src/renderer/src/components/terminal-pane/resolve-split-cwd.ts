// Prefer live OSC 7 cwd, then provider /proc/lsof lookup, then replayed OSC 7/workspace fallback; both live sources may legitimately lack evidence.
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

export type PaneCwdEntry = {
  cwd: string
  confirmed: boolean
  /** Keeps a cwd-deferred split attached until its PTY binds. */
  deferredSplitSpawn?: boolean
  pendingCwd?: Promise<string>
}

export type PaneCwdMap = Map<number, PaneCwdEntry>

/** Updates OSC 7 state without dropping a split's pre-bind admission fence. */
export function mergePaneCwdFromOsc7(
  existing: PaneCwdEntry | undefined,
  cwd: string,
  confirmed: boolean
): PaneCwdEntry {
  return {
    cwd,
    confirmed,
    ...(existing?.deferredSplitSpawn ? { deferredSplitSpawn: true } : {}),
    ...(existing?.pendingCwd ? { pendingCwd: existing.pendingCwd } : {})
  }
}

/** Drops the pre-bind lookup metadata once a split either binds or definitively fails. */
export function clearPaneCwdDeferredSpawn(
  existing: PaneCwdEntry | undefined,
  expectedPendingCwd?: Promise<string>
): PaneCwdEntry | undefined {
  if (!existing || (expectedPendingCwd && existing.pendingCwd !== expectedPendingCwd)) {
    return existing
  }
  if (!existing.deferredSplitSpawn && !existing.pendingCwd) {
    return existing
  }
  return { cwd: existing.cwd, confirmed: existing.confirmed }
}

/** Settles a pane's deferred-split lookup in place once it binds or definitively fails. */
export function settlePaneCwdDeferredSpawn(
  paneCwdMap: PaneCwdMap,
  paneId: number,
  expectedPendingCwd?: Promise<string>
): void {
  const existing = paneCwdMap.get(paneId)
  const settled = clearPaneCwdDeferredSpawn(existing, expectedPendingCwd)
  if (settled && settled !== existing) {
    paneCwdMap.set(paneId, settled)
  }
}

// Allow cold macOS lsof roughly a second; shorter renderer budgets waste main’s work and choose the root fallback, though the shared per-PID cache warms for later splits.
const GET_CWD_TIMEOUT_MS = 1000

export async function resolveSplitCwd(args: {
  paneCwdMap: PaneCwdMap
  sourcePaneId: number
  sourcePtyId: string | null
  fallbackCwd: string
}): Promise<string> {
  const { paneCwdMap, sourcePaneId, sourcePtyId, fallbackCwd } = args

  const cached = paneCwdMap.get(sourcePaneId)
  if (cached?.confirmed && cached.cwd) {
    return cached.cwd
  }

  // Bound provider lookup so slow SSH cannot stall a split.
  if (sourcePtyId && !isRemoteRuntimePtyId(sourcePtyId)) {
    try {
      const ipcCwd = await Promise.race<string | null>([
        window.api.pty.getCwd(sourcePtyId).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), GET_CWD_TIMEOUT_MS))
      ])
      if (ipcCwd) {
        return ipcCwd
      }
    } catch {
      /* fall through */
    }
  }

  if (cached?.cwd) {
    return cached.cwd
  }

  return fallbackCwd
}
