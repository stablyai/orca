// Durable "leave Chat view" hand-back listener (Critical B, wave 5).
// use-omp-rpc-chat-session.ts's acquire effect can only ask main to release
// + hand back a pane's PTY; it cannot drive the respawn itself, because the
// real trigger for "leave Chat view" (TerminalPane.tsx's portal render gate
// returning null) unmounts that hook along with NativeChatView. TerminalPane
// itself stays mounted underneath NativeChatView (Terminal.tsx renders one
// TerminalPane per tab, independent of Chat/Terminal view mode), so it is
// where main's `ompRpcChat:handback` push event must land and drive the
// actual `pty.spawn` + layout rebind — see omp-rpc-chat-handback.ts, whose
// existing respawn/rebind logic (including its tab-closed orphan reap) is
// reused verbatim here, just invoked from a surface that cannot be
// unmounted by the very action that triggers it.
import { useEffect } from 'react'
import type { OmpRpcChatClaimedHandback } from '../../../../shared/omp-rpc-chat-ipc-contract'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { respawnPtyForOmpRpcChatHandback } from './omp-rpc-chat-handback'

/** Subscribed once per tab's TerminalPane instance. The push event is not
 *  scoped to a subscriber (unlike `ompRpcChat:subscribe`'s per-pane
 *  channel) — every window's listener fires and filters by `tabId` itself,
 *  since `chatLeafId` may already be null (the user left Chat view) by the
 *  time this arrives and cannot be relied on to identify the target leaf.
 *
 *  The push is only a NUDGE (XLR-R7-001): the respawn is driven by what main
 *  hands over from `claimPendingHandbacks`, never by the pushed payload. A
 *  `webContents.send` cannot be replayed, so this renderer may be a RELOADED
 *  one that never saw the push at all — hence the claim on mount too, which is
 *  the only signal such a renderer produces. A claim is also the only thing
 *  that authorizes a respawn: several joined releases nudge several times, and
 *  acting on each payload would launch several `omp --resume` children on one
 *  session.
 *
 *  The claim only LEASES it (XLR-R8-001). Main keeps the instruction until this
 *  reports back, so every path out of a claim — a respawn that failed, and an
 *  unmount that reached the payloads before the respawn could — must settle it
 *  as un-respawned, or the pane is left with neither RPC ownership nor a PTY
 *  and nothing ever revisits it. A reload settles nothing at all, which is
 *  precisely why the lease survives one. */
export function useOmpRpcChatHandbackListener(tabId: string): void {
  useEffect(() => {
    const api = window.api?.ompRpcChat
    if (!api) {
      return
    }
    let cancelled = false
    const settle = (claim: OmpRpcChatClaimedHandback, respawned: boolean): void => {
      // An unanswerable settle leaves the lease held; the next claim from this
      // same renderer re-leases it, so a lost report is never a lost pane.
      void api.settleHandback?.({
        paneKey: claim.payload.paneKey,
        token: claim.token,
        respawned
      })
    }
    const claimAndRespawn = (): void => {
      if (!api.claimPendingHandbacks) {
        return
      }
      void api.claimPendingHandbacks({ tabId }).then(
        (claims) => {
          if (!Array.isArray(claims)) {
            return
          }
          for (const claim of claims) {
            if (cancelled) {
              // Unmounted before it could act: hand the instruction straight
              // back rather than strand the pane on a lease nothing will use.
              settle(claim, false)
              continue
            }
            void respawnPtyForOmpRpcChatHandback(claim.payload).then(
              (result) => settle(claim, result.ok),
              () => settle(claim, false)
            )
          }
        },
        // Fail closed like every other surface here: an unanswerable claim
        // leaves the instruction retained in main for the next mount.
        () => undefined
      )
    }
    claimAndRespawn()
    const stop = api.onHandback((payload) => {
      const parsed = parsePaneKey(payload.paneKey)
      if (parsed?.tabId === tabId) {
        claimAndRespawn()
      }
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [tabId])
}
