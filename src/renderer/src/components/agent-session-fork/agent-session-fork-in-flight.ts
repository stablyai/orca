// Why: module-level so a dialog unmounted mid-fork (e.g. by the orca.yaml trust prompt) still blocks a second one.
const claimsBySourceWorktreeId = new Map<string, symbol>()

/** Claims a source workspace for one fork; null while another fork of it is being created. */
export function claimAgentSessionForkSource(sourceWorktreeId: string): symbol | null {
  if (claimsBySourceWorktreeId.has(sourceWorktreeId)) {
    return null
  }
  const claim = Symbol(sourceWorktreeId)
  claimsBySourceWorktreeId.set(sourceWorktreeId, claim)
  return claim
}

/** Releases only the caller's own claim, so a stale release never frees a newer fork's claim. */
export function releaseAgentSessionForkSource(sourceWorktreeId: string, claim: symbol): void {
  if (claimsBySourceWorktreeId.get(sourceWorktreeId) === claim) {
    claimsBySourceWorktreeId.delete(sourceWorktreeId)
  }
}

export function isAgentSessionForkSourceClaimed(sourceWorktreeId: string): boolean {
  return claimsBySourceWorktreeId.has(sourceWorktreeId)
}
