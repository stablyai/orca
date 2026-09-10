// Composer send-routing for an RPC-owned pane (D6), extracted so it can be
// unit-tested against a stubbed session without mounting the composer.

import { useCallback, useEffect, useRef } from 'react'
import type {
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'

export type UseOmpRpcChatSendArgs = {
  isRpcOwned: boolean
  isRpcTurnWorking: boolean
  /** Armed by the composer's "Follow up" affordance (W2-5). */
  followUpRequested: boolean
  /** Identifies the RPC session bound to the pane when the draft is claimed.
   *  Carried into the durable notice below, because paneKey survives a rebind
   *  and the notice must not land in the session that replaced this one. */
  sessionGeneration: number
  sendChat: (args: {
    message: string
    behavior: OmpRpcChatSendBehavior
  }) => Promise<OmpRpcChatSendResult>
  /** Echo the user's own turn immediately, matching the PTY chat path's UX;
   *  the transcript still has to catch up since the RPC child writes the
   *  same session file the PTY did. */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** Retracts the echo above by its id once the send is known to have failed.
   *  The notice routes below cannot substitute for this: the echo is the claim
   *  that the message reached the agent, and it is cached under
   *  {paneKey, agent} with no generation, so no rebind and no unmount takes it
   *  off screen by itself. */
  onOptimisticSendCanceled?: (pendingId: string) => void
  /** The RPC round trip itself failed after the draft was already claimed
   *  (rare — acquisition already proved the session live). There is no PTY to
   *  fall back into: the original one already exited, or RPC wouldn't own
   *  this pane (D2). Surface it instead of silently dropping the message. */
  onSendFailed?: () => void
  /** Records the same failure through pane-owned state when this remountable
   *  hook has already unmounted (a Chat <-> Terminal toggle) and the local
   *  notice above would be written into a discarded `useState`. The dispatch
   *  generation rides along so the notice cannot land in a replacement
   *  session that took over the same paneKey. */
  onMessageFailed?: (expectedGeneration: number) => void
}

/** idle -> `prompt`; a working turn steers by default; the composer's
 *  Follow up affordance switches it to `follow_up` instead (D6). */
export function resolveOmpRpcChatSendBehavior(
  isRpcTurnWorking: boolean,
  followUpRequested: boolean
): OmpRpcChatSendBehavior {
  if (!isRpcTurnWorking) {
    return 'idle'
  }
  return followUpRequested ? 'followUp' : 'steer'
}

/**
 * Mirrors useOmpRpcLocalCommandSend's "claim the draft, return boolean"
 * contract: `false` means the caller must run its normal PTY send path
 * unchanged (D1). Text-only — the composer must not call this when the draft
 * carries image attachments; there is no new image UI for the RPC path.
 */
export function useOmpRpcChatSend(args: UseOmpRpcChatSendArgs): (text: string) => boolean {
  const {
    isRpcOwned,
    isRpcTurnWorking,
    followUpRequested,
    sessionGeneration,
    sendChat,
    onOptimisticSend,
    onOptimisticSendCanceled,
    onSendFailed,
    onMessageFailed
  } = args
  // Armed on setup rather than at declaration: StrictMode replays
  // setup -> cleanup -> setup on mount, and a flag only cleared by that
  // cleanup would make a visible composer look unmounted.
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])
  return useCallback(
    (text: string) => {
      if (!isRpcOwned) {
        return false
      }
      const message = text.trim()
      if (!message) {
        return false
      }
      const behavior = resolveOmpRpcChatSendBehavior(isRpcTurnWorking, followUpRequested)
      // The send lands in this same tick, so the rendered generation IS the
      // dispatch generation; capturing it here keeps it pinned once a later
      // rebind moves the live one on.
      const dispatchGeneration = sessionGeneration
      const pendingId = onOptimisticSend?.(text, [])
      // A send outlives this hook (toggling to Terminal unmounts the composer),
      // so every way it can fail funnels through here.
      //
      // Retracting the echo comes first and is unconditional. It is the one
      // correction whose scope matches the artifact: the echo lives in the
      // module-level pane cache keyed by {paneKey, agent} (native-chat-pending.ts)
      // and is removed by pendingId, so neither this hook's mount nor a rebind
      // can make the retraction miss — and only this send's own bubble goes,
      // never the replacement session's. Without it a failed message keeps
      // rendering as delivered no matter which notice route runs.
      //
      // The notice is then chosen by mount alone: a mounted composer shows it
      // locally, an unmounted one has nowhere to put it and hands it to
      // pane-owned state, which re-words it when the pane has since rebound
      // rather than blaming the replacement session. Writing durably while
      // mounted would be worse than useless — the composer's notice effect
      // would replay it on the next remount.
      const reportFailure = (): void => {
        if (pendingId) {
          onOptimisticSendCanceled?.(pendingId)
        }
        if (isMounted.current) {
          onSendFailed?.()
          return
        }
        onMessageFailed?.(dispatchGeneration)
      }
      // A rejection costs the draft exactly as a declined `{ ok: false }` does
      // — the round trip itself died (handler teardown, destroyed window) — so
      // it reports rather than escaping as an unhandled rejection.
      void sendChat({ message, behavior }).then((result) => {
        if (!result.ok) {
          reportFailure()
        }
      }, reportFailure)
      return true
    },
    [
      isRpcOwned,
      isRpcTurnWorking,
      followUpRequested,
      sessionGeneration,
      sendChat,
      onOptimisticSend,
      onOptimisticSendCanceled,
      onSendFailed,
      onMessageFailed
    ]
  )
}
