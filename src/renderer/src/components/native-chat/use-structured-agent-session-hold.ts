// The desktop chat telling main that this session is on screen.
//
// A structured chat is an in-place view on a terminal tab, so closing the tab unmounts this and
// nothing else in the close path knows a provider process is involved: `closeUnifiedTab` retires
// the PTY and drops the tab, main hears nothing, and a codex app-server outlives the chat for the
// rest of the app's life. Surface activity is the honest signal — it covers closing the tab,
// closing the window, and visibility changes for retained panes, none of which share a code path.
//
// The release CHAINS off the hold rather than racing it: an unmount during the hold's round trip
// would otherwise release a hold that has not landed yet, and the late hold would never be undone.
//
// The hold can resume the session on the host, so its refusal is the one place the host explains
// why this session cannot be opened (e.g. its folder is gone); that message is returned to render.

import { useEffect, useRef, useState } from 'react'
import { structuredAgentSessionHolderId } from '../../../../shared/structured-agent-session-holder'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

function holdRefusalMessage(error: unknown): string | null {
  // An older host has no such method; the session still reads, it just is not held.
  if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
    return null
  }
  return error instanceof Error && error.message ? error.message : String(error)
}

export function useStructuredAgentSessionHold(args: {
  sessionId: string
  target: RuntimeClientTarget
  surface: string
  enabled?: boolean
}): { error: string | null } {
  const { enabled = true, sessionId, surface, target } = args
  // Keyed by VALUE, not identity: callers build the target inline, so an identity dependency would
  // release and re-take the hold on every render of the pane.
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const targetRef = useRef(target)
  const holdKey = `${sessionId}\u0000${targetKey}`
  const [refusal, setRefusal] = useState<{ holdKey: string; message: string } | null>(null)
  // Synced in an effect declared first (so it lands before the hold below) rather than in render:
  // a render React discards must not leak its target into the next commit.
  useEffect(() => {
    targetRef.current = target
  }, [target])
  useEffect(() => {
    if (!enabled) {
      return
    }
    const runtimeTarget = targetRef.current
    const holderId = structuredAgentSessionHolderId(surface)
    let current = true
    const held = callStructuredAgentSession(runtimeTarget, 'agentSession.hold', {
      sessionId,
      holderId
    }).then(
      () => {
        if (current) {
          setRefusal(null)
        }
      },
      (error: unknown) => {
        const message = holdRefusalMessage(error)
        console.warn('[structured-agent-session] hold failed:', error)
        if (current) {
          setRefusal(message === null ? null : { holdKey, message })
        }
      }
    )
    return () => {
      current = false
      void held.then(() =>
        callStructuredAgentSession(runtimeTarget, 'agentSession.release', {
          sessionId,
          holderId
        }).catch(() => undefined)
      )
    }
  }, [enabled, holdKey, sessionId, surface])
  // Keyed so a refusal for one session never shows on the next session this pane renders.
  return { error: refusal?.holdKey === holdKey ? refusal.message : null }
}
