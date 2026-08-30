import type { ExecutionHostId } from './execution-host'

/**
 * What it means that a scan did not list a workspace. `exited` is a positive
 * answer: the host listed its workspaces and this one was not among them.
 * `unverifiable` is the absence of one — the host was out of contact, or the scan
 * never covered this repo. Per `docs/reference/ssh-execution-boundary.md` loss of
 * contact is never evidence, so anything short of a completed listing reads as
 * `unverifiable` and a row may not be retired on it.
 */
export type WorkspaceCleanupOmissionVerdict = 'unverifiable' | 'exited'

/** What one repo's scan established about the workspaces it did not list. */
export type WorkspaceCleanupRepoListing = {
  repoId: string
  /** Required: every repo the scan visits resolves to exactly one execution host,
   *  and an unqualified listing would let one host's answer retire another's row. */
  executionHostId: ExecutionHostId
  verdict: WorkspaceCleanupOmissionVerdict
}

/**
 * Reads the verdict for a workspace the scan omitted. `exited` needs a listing
 * that covers this workspace's own host and says so; every other shape — a host
 * that publishes no listings, a repo the scan never reached, a listing for a
 * sibling host or a sibling repo only — leaves the omission `unverifiable`.
 */
export function resolveWorkspaceCleanupOmissionVerdict(
  target: { repoId: string; executionHostId: ExecutionHostId | null },
  listings: readonly WorkspaceCleanupRepoListing[] | undefined
): WorkspaceCleanupOmissionVerdict {
  const covering = (listings ?? []).filter(
    (listing) =>
      listing.repoId === target.repoId &&
      (target.executionHostId === null || listing.executionHostId === target.executionHostId)
  )
  // Why every and not some: an unqualified target is covered by each host that
  // owns the repo, and one host out of contact leaves the omission unexplained.
  return covering.length > 0 && covering.every((listing) => listing.verdict === 'exited')
    ? 'exited'
    : 'unverifiable'
}
