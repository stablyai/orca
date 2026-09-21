// The only place a new fence number is chosen.
//
// Normally that is just "one past the current fence". After the record store falls back to its
// backup it is not: the commit that never landed may already have granted a fence the backup cannot
// show, and `isAgentSessionFenceCurrent` compares with STRICT EQUALITY, so minting that exact
// number would hand a second writer a lease the first one still believes it holds.
//
// Recovery records the floor instead of rewriting the current fence, because `live` means a handle
// proven at exactly the current fence — moving it would invalidate the very records recovery exists
// to save. A source-level ratchet rejects direct `+ 1` mints, while acquisition-transition tests
// pin the one-step bound and floor; an indirected mint is not caught.

import type { AgentSessionLease } from './agent-session-record'

export function nextAgentSessionFence(lease: AgentSessionLease): number {
  return Math.max(lease.runtimeFence + 1, lease.minimumNextFence ?? 0)
}
