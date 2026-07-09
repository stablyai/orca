// Why: while a fit hold is active, ResizeObserver still measures the local
// pane. For mobile-fit the server treats remote desktop viewport RPCs as
// measurement-only (terminalFitOverrides gate). remote-desktop-fit is NOT in
// that map — forwarding passive geometry as transport.resize would arrive as
// control intent and re-claim size ownership (desktop tug-of-war).

export type FitHoldPassiveMode = 'mobile-fit' | 'remote-desktop-fit'

/**
 * Whether a remote-runtime pane may emit transport.resize for a passive
 * geometry observation while a fit hold is active.
 */
export function shouldForwardRemotePassiveGeometryWhileHeld(
  fitMode: FitHoldPassiveMode | null | undefined
): boolean {
  return fitMode === 'mobile-fit'
}
