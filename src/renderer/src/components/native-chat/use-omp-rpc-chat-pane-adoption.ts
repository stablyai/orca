// Why a pane with NO PTY may still engage RPC ownership.
//
// XLR-R6-004 (cross-lab review): first engagement requires a live `ptyId`
// because Decision 1's acquisition hands that terminal over — but a renderer
// restarted by Cmd+R or crash recovery is a first engagement with nothing to
// hand over. The main registry survives the reload, while the hook refs and the
// renderer store restart, and the restored tab/layout still carry the null PTY
// binding acquisition itself wrote. The eligibility gate then stayed false
// forever: the surviving `omp --mode rpc` child had no chat owner, nobody to
// subscribe to its frames, and nobody to release it — a pane with neither a
// terminal nor a session.
//
// Main's own registration is the only evidence that case is real, so it is
// asked. Deliberately NOT a relaxation of the gate in general: a pane whose PTY
// is merely not spawned yet must keep waiting for it, or its one acquire
// attempt is spent on a null terminal it can never prove exited.
//
// Split from use-omp-rpc-chat-pane-ownership.ts, which is at its line budget.

import { useEffect, useState } from 'react'

/** Main's authoritative session file when it still holds a session for this pane, else null.
 *  Never probes while the pane has a PTY of its own — that is the ordinary
 *  first-engagement path and needs no adoption. */
export function useOmpRpcChatAdoptableIdentity(
  paneKey: string | null,
  hasPty: boolean
): string | null {
  const [adoptedSessionFile, setAdoptedSessionFile] = useState<string | null>(null)
  useEffect(() => {
    const api = window.api?.ompRpcChat
    if (hasPty || paneKey === null || !api?.hasSession) {
      setAdoptedSessionFile(null)
      return
    }
    setAdoptedSessionFile(null)
    let cancelled = false
    void api.hasSession({ paneKey }).then(
      (ownedSession) => {
        if (ownedSession && !cancelled) {
          setAdoptedSessionFile(ownedSession.sessionFile)
        }
      },
      // Fail closed like every other surface here: an unanswerable probe leaves
      // the pane on its existing (PTY-requiring) gate.
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [hasPty, paneKey])
  return adoptedSessionFile
}
