// What a FAILED RPC acquire still owes the pane's PTY. Split out of
// use-omp-rpc-chat-pane-ownership.ts (which is at its line budget) because it
// is one closed decision with three inputs — did the stop land, what did main
// refuse with, and does a newer owner hold the pane — and it reads better
// beside the two hand-back primitives it dispatches to than inline in the
// acquire flow.

import { useAppStore } from '@/store'
import type { OmpRpcChatAcquireResult } from '../../../../shared/omp-rpc-chat-ipc-contract'
import {
  respawnPtyForOmpRpcChatHandbackWithRetry,
  restorePtyBindingsAfterRefusedOmpRpcAcquire
} from './omp-rpc-chat-handback'

type OmpRpcChatAcquireFailure = Extract<OmpRpcChatAcquireResult, { ok: false }>

type OmpRpcAcquireRespawnContext = { replacedPtyId: string; cwd: string; sessionId: string }

/**
 * Settles the pane's PTY after `acquire` refused, so it is never left with
 * neither a terminal nor a session.
 *
 * - The stop landed and main's refusal leaves the PTY provably gone: respawn
 *   the session into the same pane. `live`/`unverifiable` are excluded
 *   (XLR-001) — those are main's own liveness verdicts on that exact PTY, and
 *   a second `omp --resume` beside a child that may still be writing the
 *   session file is the single-writer violation this feature is proof-gated to
 *   prevent.
 * - A `conflict` that follows a landed stop is owed NEITHER either (XLR-047):
 *   conflict means someone else's claim holds this session — a release that
 *   failed closed, or a second pane racing for it — which is not evidence that
 *   no writer is live, while the pane's own PTY is by then provably gone.
 * - `rpc-child-unverifiable` is owed NEITHER (XLR-041/XLR-043): main proved
 *   this pane's PTY exited before it spawned the RPC child — that proof is what
 *   admitted the spawn — and then could not prove the child exited. A respawn
 *   puts a second `omp --resume` beside a child that may still be writing the
 *   session file, and the pre-kill undo would re-point the pane at a terminal
 *   that is provably gone, resurrecting a dead pty id in the tab and layout
 *   records. The pane keeps no terminal until the child's exit becomes
 *   observable (docs/omp-rpc-dependency-followups.md).
 * - Any other refusal leaves the ORIGINAL PTY unproven-gone while
 *   `killPtyBeforeOmpRpcAcquire` has already armed its exit suppression and
 *   erased its tab/leaf bindings, so undo those instead (XLR-006).
 * - Neither is owed once a NEWER run has ACQUIRED this pane (XLR-010). Being
 *   superseded alone is not enough — the superseded run is precisely who owes
 *   the PTY back when nothing replaced it — but an RPC-owned pane leaves its
 *   leaf unbound by design, and both helpers accept an unbound leaf, so either
 *   one would bind the OLD session's PTY over a live newer RPC session that
 *   can then no longer hand back through its expected binding. A published
 *   `acquired` can only be that newer run's: this effect republishes
 *   `idle`/`pending` when it starts and is here because it never acquired.
 *   The suppression this run armed is still this run's to disarm, and only
 *   when the stop was refused — a kill that landed still owes its own exit
 *   that flag.
 */
export async function recoverPtyAfterRefusedOmpRpcAcquire(args: {
  paneKey: string
  respawnContext: OmpRpcAcquireRespawnContext
  killed: boolean
  result: OmpRpcChatAcquireFailure
}): Promise<void> {
  await settlePtyAfterUnownedOmpRpcAcquire({
    paneKey: args.paneKey,
    respawnContext: args.respawnContext,
    killed: args.killed,
    owed: refusedOmpRpcAcquireOwes(args.result.reason, args.killed)
  })
}

/** What a given refusal owes this pane's PTY — see the cases in the doc
 *  comment above. */
function refusedOmpRpcAcquireOwes(
  reason: OmpRpcChatAcquireFailure['reason'],
  killed: boolean
): OmpRpcAcquireSettleObligation {
  if (reason === 'rpc-child-unverifiable') {
    return 'none'
  }
  // `conflict` says another owner holds this session's claim, NOT that no
  // writer ever started (XLR-047, cross-lab review): a release that failed
  // closed leaves its child registered and possibly streaming, and a second
  // pane racing for the same session holds a live claim of its own. Resuming
  // `omp --resume` beside either is the single-writer violation this feature is
  // proof-gated to prevent, and once the stop landed the pane's own PTY is
  // provably gone, so the pre-kill undo would resurrect a dead pty id. A
  // refused stop still owes that undo — the PTY it names is still running.
  if (reason === 'conflict' && killed) {
    return 'none'
  }
  // `live`/`unverifiable` are main's own verdicts on this exact PTY: a second
  // `omp --resume` beside a child that may still be writing the session file
  // is the single-writer violation this feature is proof-gated to prevent.
  return killed && reason !== 'live' && reason !== 'unverifiable' ? 'respawn' : 'restore'
}

/** The acquire was never dispatched at all: the pane unmounted, went
 *  invisible-before-ever-visible, or rebound identity while the pre-acquire
 *  PTY kill was still in flight (XLR-015, cross-lab review). There is no
 *  main-side verdict to weigh here, so the stop's own result is the whole
 *  input — a kill that landed owes the PTY back, a refused one owes the
 *  pre-kill mutations undone — and the same "a newer run already acquired"
 *  exclusion applies. */
export async function recoverPtyAfterAbandonedOmpRpcAcquire(args: {
  paneKey: string
  respawnContext: OmpRpcAcquireRespawnContext
  killed: boolean
}): Promise<void> {
  await settlePtyAfterUnownedOmpRpcAcquire({ ...args, owed: args.killed ? 'respawn' : 'restore' })
}

type OmpRpcAcquireSettleObligation = 'respawn' | 'restore' | 'none'

async function settlePtyAfterUnownedOmpRpcAcquire(args: {
  paneKey: string
  respawnContext: OmpRpcAcquireRespawnContext
  killed: boolean
  owed: OmpRpcAcquireSettleObligation
}): Promise<void> {
  const { paneKey, respawnContext, killed, owed } = args
  // Nothing to settle for a pane that had no PTY to begin with (an adopting
  // renderer, XLR-R6-004): there was no stop, no armed suppression, and no
  // erased binding — and both helpers below would write an empty pty id into
  // the tab and layout records if handed one.
  if (!respawnContext.replacedPtyId) {
    return
  }
  if (
    owed === 'none' ||
    useAppStore.getState().ompRpcChatOwnershipByPaneKey[paneKey]?.status === 'acquired'
  ) {
    if (!killed) {
      useAppStore.getState().consumeSuppressedPtyExit(respawnContext.replacedPtyId)
    }
    return
  }
  if (owed === 'respawn') {
    await respawnPtyForOmpRpcChatHandbackWithRetry({ paneKey, ...respawnContext })
    return
  }
  restorePtyBindingsAfterRefusedOmpRpcAcquire({ paneKey, ptyId: respawnContext.replacedPtyId })
}
