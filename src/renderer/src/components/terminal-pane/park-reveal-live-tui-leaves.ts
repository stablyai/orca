import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

/** Preserve captured remote TUI frames across park; the host remains live and reattach leaves alt-screen mode when needed. */
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
