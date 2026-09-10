// @vitest-environment happy-dom

// The three-way decision in omp-rpc-acquire-failure-pty-recovery.ts, asserted
// on the module itself rather than through the ownership hook, whose test file
// is at its max-lines budget. The two hand-back primitives are mocked: what
// matters here is WHICH one a refusal earns, not the store/layout rebind
// machinery omp-rpc-chat-handback.test.ts already covers.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OmpRpcChatAcquireFailureReason } from '../../../../shared/omp-rpc-chat-ipc-contract'

const respawnPtyForOmpRpcChatHandbackWithRetry = vi.hoisted(() => vi.fn(async () => {}))
const restorePtyBindingsAfterRefusedOmpRpcAcquire = vi.hoisted(() => vi.fn())

vi.mock('./omp-rpc-chat-handback', () => ({
  respawnPtyForOmpRpcChatHandbackWithRetry,
  restorePtyBindingsAfterRefusedOmpRpcAcquire
}))

import { recoverPtyAfterRefusedOmpRpcAcquire } from './omp-rpc-acquire-failure-pty-recovery'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const RESPAWN_CONTEXT = { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }

async function recover(reason: OmpRpcChatAcquireFailureReason, killed = true): Promise<void> {
  await recoverPtyAfterRefusedOmpRpcAcquire({
    paneKey: PANE_KEY,
    respawnContext: RESPAWN_CONTEXT,
    killed,
    result: { ok: false, reason }
  })
}

describe('recoverPtyAfterRefusedOmpRpcAcquire', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.clearAllMocks()
  })

  // XLR-041 / XLR-043 (cross-lab review): `rpc-child-unverifiable` is main's
  // verdict on the RPC CHILD, not on this pane's PTY — that PTY is provably
  // exited, because proving it is what admitted the child's spawn. Respawning
  // puts a second `omp --resume` beside a child that may still be writing the
  // session file (the single-writer violation this feature is proof-gated to
  // prevent), and the pre-kill undo re-points the pane's tab and layout records
  // at a process that is gone. Both used to happen: the failed-init path
  // reported the PTY's `unverifiable` and got the undo, the superseded-acquire
  // path reported a plain `conflict` and got the respawn.
  it('owes the pane neither a respawn nor the pre-kill undo when the RPC child exit is unproven', async () => {
    await recover('rpc-child-unverifiable')

    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
    expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).not.toHaveBeenCalled()
  })

  // The suppression this run armed is still this run's to disarm, and only when
  // the stop was refused — a kill that landed still owes its own exit that flag.
  it('disarms the exit suppression it armed when the stop was refused', async () => {
    useAppStore.getState().suppressPtyExit('pty-1')

    await recover('rpc-child-unverifiable', false)

    expect(useAppStore.getState().consumeSuppressedPtyExit('pty-1')).toBe(false)
  })

  // The verdicts on this pane's own PTY keep their existing recovery (XLR-001 /
  // XLR-006), so the new status above is a split, not a redirect.
  it.each(['live', 'unverifiable'] as const)('undoes the pre-kill mutations on "%s"', async (r) => {
    await recover(r)

    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
    expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      ptyId: 'pty-1'
    })
  })

  it.each(['spawn-failed', 'executable-not-found'] as const)(
    'respawns the pane PTY on "%s" once the stop landed',
    async (reason) => {
      await recover(reason)

      expect(respawnPtyForOmpRpcChatHandbackWithRetry).toHaveBeenCalledWith({
        paneKey: PANE_KEY,
        ...RESPAWN_CONTEXT
      })
      expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).not.toHaveBeenCalled()
    }
  )

  // XLR-047 (cross-lab review): `conflict` is a statement about who holds the
  // session's CLAIM, never proof that no writer is live — a release that failed
  // closed keeps its (possibly streaming) child registered, and a second pane
  // racing for the same session holds a live claim of its own. Resuming `omp
  // --resume` on top of either is the single-writer violation this feature is
  // proof-gated to prevent. This used to respawn.
  it('owes the pane neither recovery on a conflict once the stop landed', async () => {
    await recover('conflict')

    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
    expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).not.toHaveBeenCalled()
  })

  // A refused stop is the other half of that split: the PTY named in the
  // respawn context is still running, so the pre-kill mutations are still owed
  // their undo — only a landed stop leaves nothing to point back at.
  it('undoes the pre-kill mutations on a conflict when the stop was refused', async () => {
    await recover('conflict', false)

    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
    expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      ptyId: 'pty-1'
    })
  })
})
