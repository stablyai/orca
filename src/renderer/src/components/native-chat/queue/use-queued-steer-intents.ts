import type { StructuredAgentSessionReadOwner } from '../session/structured/read/structured-agent-session-read-owner-contract'
import { useCallback, useMemo, useState } from 'react'
import { structuredSessionOperationId } from '../session/structured/writes/structured-agent-session-operation-id'
import type { AgentSessionSendResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionState } from '../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import {
  reconcileQueuedSteerIntents,
  settleQueuedSteerRequest
} from '../../../../../shared/agent-session/view/structured-agent-session-sending-queued-cards'

const EMPTY: ReadonlyMap<string, string> = new Map()

export function useQueuedSteerIntents(
  owner: StructuredAgentSessionReadOwner,
  {
    epoch,
    fence,
    queuePause,
    queuedMessages,
    submissions
  }: Pick<StructuredAgentSessionState, 'epoch' | 'fence' | 'queuePause'> & {
    queuedMessages: Readonly<StructuredAgentSessionState['queuedMessages']>
    submissions: Readonly<StructuredAgentSessionState['submissions']>
  },
  agentWorking: boolean
) {
  const scope = useMemo(() => ({ owner, epoch, fence }), [owner, epoch, fence])
  const [state, setState] = useState({ scope, intents: EMPTY })
  const intents =
    state.scope === scope
      ? reconcileQueuedSteerIntents(state.intents, queuedMessages ?? null, submissions, {
          agentWorking,
          queuePaused: queuePause != null
        })
      : EMPTY
  if (state.scope !== scope || state.intents !== intents) {
    setState({ scope, intents })
  }
  const request = useCallback(
    async (
      id: string,
      steers: boolean,
      send: (operation?: string) => Promise<AgentSessionSendResult | null>
    ) => {
      if (!steers) {
        return send()
      }
      const operation = structuredSessionOperationId()
      setState((current) =>
        current.scope === scope
          ? { scope, intents: new Map(current.intents).set(id, operation) }
          : current
      )
      return settleQueuedSteerRequest(
        () => send(operation),
        () =>
          setState((current) => {
            if (current.scope !== scope || current.intents.get(id) !== operation) {
              return current
            }
            const next = new Map(current.intents)
            next.delete(id)
            return { scope, intents: next }
          })
      )
    },
    [scope]
  )
  return { intents, request }
}
