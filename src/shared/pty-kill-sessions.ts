export type PtyKillIntent = 'orphan-cleanup' | 'owner-close'

/** Maximum session refs accepted by one bulk kill request (matches other bulk IPC contracts). */
export const MAX_PTY_KILL_SESSION_REFS = 512

export type DescendantSweepOutcome =
  | 'tree_terminated'
  | `tree_refused:${string}`
  | 'tree_unavailable'

export type PtyKillSessionRef = {
  id: string
  incarnationId?: string
}

export type PtyKillSessionResult = PtyKillSessionRef & {
  verdict: 'exited' | 'live' | 'unverifiable' | 'refused'
  reason?: string
  survivorPids?: number[]
  treeUnverified?: true
  fenceUnavailable?: true
}
