// Who still owes a pane's RPC release once one effect run supersedes another.
// Split out of use-omp-rpc-chat-pane-ownership.ts (at its line budget) because
// it is one closed decision with one hard rule: an older run may drop its
// release obligation only once a successor has PROVABLY taken the claim off
// it, which the successor's own acquire outcome is the only evidence of.

/** One effect run's pursuit of a paneKey. `acquired` settles when that run's
 *  acquire flow finishes, carrying whether it ended up holding the session —
 *  the only thing that makes it a successor rather than a mere contender. */
export type OmpRpcPanePursuit = {
  paneKey: string
  generation: number
  acquired: Promise<boolean>
}

/** How many times cleanup may re-ask for a release main keeps refusing
 *  (XLR-026). The retry loop used to be unbounded AND, after a FINAL unmount,
 *  uncancellable: nothing bumps the generation it fences on, so a refusal main
 *  can never resolve — a protocol-faulted child whose exit it cannot prove
 *  (docs/omp-rpc-dependency-followups.md) — kept starting release plus
 *  exit-proof cycles for the app's life, and an immediate permanent refusal
 *  (ownership-unknown) spun them as fast as IPC answers. No artificial backoff:
 *  every attempt already awaits main's own bounded settle+exit-proof window, so
 *  a bound is the safeguard that was actually missing. What remains once it is
 *  spent is a claim still held — the same fail-closed remainder any refused
 *  release leaves, retried by the next acquire on this paneKey
 *  (omp-rpc-chat-session-registry.ts) and released for certain by `disposeAll`
 *  at quit. */
export const OMP_RPC_CLEANUP_RELEASE_MAX_ATTEMPTS = 6

/** Registers `generation` as the run now pursuing `paneKey`, returning the
 *  settle callback its acquire flow must call with whether it acquired. */
export function beginOmpRpcPanePursuit(
  ref: { current: OmpRpcPanePursuit | null },
  paneKey: string,
  generation: number
): (acquired: boolean) => void {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  ref.current = { paneKey, generation, acquired: promise }
  return resolve
}

/** The pursuit a stale run may hand its release obligation to, or null when it
 *  must keep it. A bumped generation alone is not a successor (XLR-031): the
 *  newer run must actually be pursuing THIS paneKey for its acquire to reclaim
 *  the stale claim. */
export function inheritingOmpRpcPanePursuit(
  pursuit: OmpRpcPanePursuit | null,
  paneKey: string,
  generation: number,
  currentGeneration: number
): Promise<boolean> | null {
  if (generation === currentGeneration || pursuit === null) {
    return null
  }
  return pursuit.paneKey === paneKey && pursuit.generation > generation ? pursuit.acquired : null
}

/** Releases until main confirms, the attempts are spent, or a successor takes
 *  the claim.
 *
 *  Why the obligation waits on the pursuit's OUTCOME (XLR-R2-001, cross-lab
 *  review round 2): engaging a pane is an intent to reclaim, not a reclaim.
 *  The successor's acquire — and its single conflict retry — can both be
 *  refused by the very child this stale run is still trying to release, and a
 *  refused `conflict` is deliberately owed no PTY restore and never
 *  re-acquires on its own. Yielding on engagement alone therefore left the
 *  claim with nobody holding the retry, so the pane ended up with neither a
 *  PTY nor RPC ownership until an unrelated remount or quit. Waiting is also
 *  what keeps the two safe: releasing while a successor's acquire is in flight
 *  could retire the session it is about to register. */
export async function releaseOmpRpcPaneClaimOnCleanup(
  requestRelease: () => Promise<boolean>,
  inheritor: () => Promise<boolean> | null
): Promise<void> {
  // Main owns each bounded settle window; this cleanup keeps its release
  // obligation for as many attempts as the bound above allows.
  for (let attempt = 0; attempt < OMP_RPC_CLEANUP_RELEASE_MAX_ATTEMPTS; attempt += 1) {
    const pursuit = inheritor()
    if (pursuit !== null && (await pursuit)) {
      return
    }
    if (await requestRelease()) {
      return
    }
  }
}
