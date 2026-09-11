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
// Neither call is swallowed. Hold is what reacquires a provider for a restored session, so its
// outcome is the pane's state, and a release that failed is the one way a provider child outlives
// every surface with nothing anywhere to say so.

import { useCallback, useEffect, useRef, useState } from 'react'
import { structuredAgentSessionHolderId } from '../../../../shared/structured-agent-session-holder'
import { STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  classifyStructuredAgentSessionHoldFailure,
  type StructuredAgentSessionHoldOutcome,
  type StructuredAgentSessionHoldState
} from './structured-agent-session-hold-outcome'

type HoldParams = { sessionId: string; holderId: string }

async function acquireHold(
  target: RuntimeClientTarget,
  params: HoldParams
): Promise<StructuredAgentSessionHoldOutcome> {
  if (target.kind === 'environment') {
    // Negotiated, never speculative: a refusal from a host that has no hold method is
    // indistinguishable from a real one, and asking a host that never answered is a wake this
    // pane has no reason to make.
    try {
      const supported = await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY
      )
      if (!supported) {
        return { kind: 'unsupported' }
      }
    } catch {
      return { kind: 'unreachable' }
    }
  }
  try {
    await callStructuredAgentSession(target, 'agentSession.hold', params)
    return { kind: 'held' }
  } catch (error) {
    return classifyStructuredAgentSessionHoldFailure(
      error,
      target.kind === 'environment' ? 'paired' : 'local'
    )
  }
}

export function useStructuredAgentSessionHold(args: {
  sessionId: string
  target: RuntimeClientTarget
  surface: string
  enabled?: boolean
}): { state: StructuredAgentSessionHoldState; retry: () => void } {
  const { enabled = true, sessionId, surface, target } = args
  // Keyed by VALUE, not identity: callers build the target inline, so an identity dependency would
  // release and re-take the hold on every render of the pane.
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const targetRef = useRef(target)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<StructuredAgentSessionHoldState>({ kind: 'idle' })
  // Synced in an effect declared first (so it lands before the hold below) rather than in render:
  // a render React discards must not leak its target into the next commit.
  useEffect(() => {
    targetRef.current = target
  }, [target])
  useEffect(() => {
    if (!enabled) {
      setState((current) => (current.kind === 'idle' ? current : { kind: 'idle' }))
      return
    }
    const runtimeTarget = targetRef.current
    const holderId = structuredAgentSessionHolderId(surface)
    let mounted = true
    setState({ kind: 'pending' })
    const held = acquireHold(runtimeTarget, { sessionId, holderId })
    void held.then((outcome) => {
      if (mounted) {
        setState(outcome)
      }
    })
    return () => {
      mounted = false
      void held.then((outcome) => {
        if (outcome.kind !== 'held') {
          return
        }
        void callStructuredAgentSession(runtimeTarget, 'agentSession.release', {
          sessionId,
          holderId
        }).catch((error) => {
          // Nothing is on screen to tell by the time this runs; the log is the only witness that
          // the host is still holding a provider child for a surface that is gone.
          console.warn('[agent-session] release failed', sessionId, error)
        })
      })
    }
  }, [attempt, enabled, sessionId, surface, targetKey])
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  return { state, retry }
}
