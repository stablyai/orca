// Older hosts need surface hold/release to retire providers on close/hide; chain release after hold to avoid leaking late holds. Keep until the minimum host version ignores both.

import { useEffect, useRef } from 'react'
import { structuredAgentSessionHolderId } from '../../../../shared/structured-agent-session-holder'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

export function useStructuredAgentSessionHold(args: {
  sessionId: string
  target: RuntimeClientTarget
  surface: string
  enabled?: boolean
}): void {
  const { enabled = true, sessionId, surface, target } = args
  // Key by value: callers build targets inline, so identity dependencies would churn holds on every render.
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const targetRef = useRef(target)
  // Commit the target before holding; discarded renders must not leak targets into later commits.
  useEffect(() => {
    targetRef.current = target
  }, [target])
  useEffect(() => {
    if (!enabled) {
      return
    }
    const runtimeTarget = targetRef.current
    const holderId = structuredAgentSessionHolderId(surface)
    const held = callStructuredAgentSession(runtimeTarget, 'agentSession.hold', {
      sessionId,
      holderId
    }).catch((error: unknown) => {
      // The session still reads, and a send restarts the agent itself; this only leaves a trace.
      console.warn('[structured-agent-session] hold failed:', error)
    })
    return () => {
      void held.then(() =>
        callStructuredAgentSession(runtimeTarget, 'agentSession.release', {
          sessionId,
          holderId
        }).catch(() => undefined)
      )
    }
  }, [enabled, sessionId, surface, targetKey])
}
