// Why: resolving the "where should the new split start?" question is a
// two-layer strategy — OSC 7 from the live shell (fast, authoritative) with a
// `/proc`-or-lsof-backed IPC fallback for shells that never emit OSC 7 (agent
// TUIs, minimal sh). Both layers can legitimately come back empty, so the
// helper always finishes by returning the caller's worktree-root fallback.
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'

export type PaneCwdEntry = { cwd: string; confirmed: boolean }

export type PaneCwdMap = Map<number, PaneCwdEntry>

// Why: sized to cover a cold `lsof -p <pid> -d cwd` on macOS (typically
// 100–500ms, occasionally up to ~1s). Shorter budgets here would cause the
// renderer to give up and fall back to the worktree root while the main
// process keeps working — wasted effort and a worse split. The main side
// coalesces and caches per-pid, so a dropped call still warms the cache
// for the next Cmd+D.
const GET_CWD_TIMEOUT_MS = 1000

export async function resolveSplitCwd(args: {
  paneCwdMap: PaneCwdMap
  sourcePaneId: number
  sourcePtyId: string | null
  fallbackCwd: string
}): Promise<string> {
  const { paneCwdMap, sourcePaneId, sourcePtyId, fallbackCwd } = args

  // 1) Live OSC 7 wins — no IPC round-trip needed.
  const cached = paneCwdMap.get(sourcePaneId)
  if (cached?.confirmed && cached.cwd) {
    return cached.cwd
  }

  // 2) Ask the PTY provider (/proc or lsof). Enforce a soft timeout
  //    renderer-side so a slow SSH relay can't stall the split.
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

  // 3) Last-ditch: replayed OSC 7 that we couldn't confirm as live.
  if (cached?.cwd) {
    return cached.cwd
  }

  return fallbackCwd
}
