import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

/** Leaves whose captured TUI frame a park-reveal remount should keep painting.
 *  Why remote only: a parked remote TUI outlives the park on its host, and every remote
 *  reattach paint leaves alt itself when the host's screen no longer uses it. */
export function resolveParkRevealLiveTuiLeafIds(
  mountFollowsTerminalPark: boolean,
  ptyIdsByLeafId: Record<string, string> | undefined
): ReadonlySet<string> | undefined {
  if (!mountFollowsTerminalPark) {
    return undefined
  }
  return new Set(
    Object.entries(ptyIdsByLeafId ?? {})
      .filter(([, ptyId]) => isRemoteRuntimePtyId(ptyId))
      .map(([leafId]) => leafId)
  )
}
