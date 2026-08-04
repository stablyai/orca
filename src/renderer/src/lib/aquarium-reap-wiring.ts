// T6 (frontend follow-up to T5): the Reap verb's disposal wiring, extracted
// into a self-contained, dependency-free module so the IPC path is unit-
// testable without dragging the full AquariumPanel (or the unrelated
// daemonInventory feature) into the test graph.
//
// This is the ONLY place the renderer reaches across the IPC bridge to dispose
// a worktree. The contract types live in src/shared/aquarium-reap.ts (committed
// in the T5 backend at 226dfa2b8) and the preload bridge in
// window.api.aquarium.reap (also committed in T5). No backend, shared, or
// preload code is touched here — this module only *calls* the existing bridge.
//
// Why a module and not an inline call in the component: the existing
// AquariumPanel.tsx is entangled with the uncommitted daemonInventory feature,
// so a test that renders it cannot be committed without entangling that work.
// Pulling the pure wiring (build request -> invoke bridge -> classify result)
// out gives T6 a clean, daemonInventory-free renderer test surface that
// exercises the exact path the UI uses.

import type { AquariumReapDenyReason, AquariumReapResult } from '../../../shared/aquarium-reap'

/** Minimal identity slice the wiring needs to build an AquariumReapRequest. */
export type ReapWorktreeIdentity = {
  repoPath?: string | null
  repo?: string | null
  path?: string | null
}

/**
 * Classified outcome of a single-worktree reap, derived from the server's
 * AquariumReapResult. The component switches on `kind` to drive toasts and the
 * reaped/denied UI sets.
 */
export type ReapOutcome =
  | { kind: 'missing-path'; path: string | null }
  | { kind: 'reaped'; path: string; result: AquariumReapResult }
  | { kind: 'failed'; path: string; error: string; result: AquariumReapResult }
  | {
      kind: 'denied'
      path: string
      reason: AquariumReapDenyReason
      detail?: string
      result: AquariumReapResult
    }

/**
 * Invoke the `aquarium:reap` IPC bridge for a single worktree and classify the
 * result. The server re-derives ownership and guard state and refuses anything
 * it would not own — the client-side deny gate in the component is UX-only and
 * is never trusted here, so a denied/failed response is surfaced honestly
 * rather than swallowed.
 */
export async function reapWorktree(identity: ReapWorktreeIdentity): Promise<ReapOutcome> {
  const repoPath = identity.repoPath ?? identity.repo
  const worktreePath = identity.path
  // The backend requires both paths; without them there is nothing to reap.
  if (!repoPath || !worktreePath) {
    return { kind: 'missing-path', path: worktreePath ?? null }
  }
  const result = await window.api.aquarium.reap({ repoPath, worktreePaths: [worktreePath] })
  if (result.reaped.includes(worktreePath)) {
    return { kind: 'reaped', path: worktreePath, result }
  }
  if (result.failed.length > 0) {
    return { kind: 'failed', path: worktreePath, error: result.failed[0].error, result }
  }
  // Backend refused (not-found / owner-uid / guard-block) — surface as denied.
  const blocked = result.denied[0]
  return {
    kind: 'denied',
    path: worktreePath,
    reason: blocked?.reason ?? 'not-found',
    detail: blocked?.detail,
    result
  }
}
