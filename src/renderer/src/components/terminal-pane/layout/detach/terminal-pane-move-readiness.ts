import type { PaneCwdEntry } from '../split/resolve-split-cwd'

/** Whether a pane can move to a new tab now; menus show it, and the move checks it again. */
export type PaneMoveReadiness = 'ready' | 'single-pane' | 'starting'

export type PaneMoveReadinessInput = {
  paneCount: number
  /** The PTY the pane's transport is attached to now; it outranks the saved layout. */
  livePtyId: string | null | undefined
  persistedPtyId: string | null | undefined
  sourcePaneCwd?: Pick<PaneCwdEntry, 'pendingCwd' | 'deferredSplitSpawn'>
  /** The transport is still awaiting its PTY id from a spawn or reattach. */
  connectPending: boolean
}

export function paneMoveReadiness(input: PaneMoveReadinessInput): PaneMoveReadiness {
  if (input.paneCount <= 1) {
    return 'single-pane'
  }
  const cwdDeferred = Boolean(
    input.sourcePaneCwd?.pendingCwd || input.sourcePaneCwd?.deferredSplitSpawn
  )
  // A late spawn would bind SOURCE:leaf and graft the moved leaf back beside its duplicate (STA-9259).
  if ((cwdDeferred || input.connectPending) && !input.persistedPtyId && !input.livePtyId) {
    return 'starting'
  }
  return 'ready'
}
