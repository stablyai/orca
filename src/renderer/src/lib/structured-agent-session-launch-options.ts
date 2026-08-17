import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'

export async function applyStructuredAgentLaunchOptions(
  intent: StructuredAgentSessionLaunchIntent,
  values: Record<string, SessionOptionValue>
): Promise<void> {
  const [options, history] = await Promise.all([
    callStructuredAgentSession<AgentSessionOptionsResult>(intent.target, 'agentSession.options', {
      sessionId: intent.sessionId
    }),
    callStructuredAgentSession<AgentSessionHistoryResult>(intent.target, 'agentSession.history', {
      sessionId: intent.sessionId,
      direction: 'tail',
      limit: 1
    })
  ])
  const fence = history.page.fence
  if (fence === undefined) {
    throw new Error('structured session fence unavailable')
  }
  for (const [key, value] of Object.entries(values)) {
    if (!options.descriptors?.some((descriptor) => descriptor.id === key && descriptor.settable)) {
      continue
    }
    const wireValue = String(value)
    const fields = { key, value: wireValue }
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionOptionResult>
    >(intent.target, 'agentSession.setOption', {
      envelope: {
        sessionId: intent.sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: intent.sessionId,
          fields
        })
      },
      ...fields
    })
    if (!result.ok) {
      throw new Error(result.refusal.message)
    }
  }
}

export async function completeLaunchOptions(
  state: {
    intent: StructuredAgentSessionLaunchIntent
    sessionOptions?: Record<string, SessionOptionValue>
  },
  launched: Promise<StructuredAgentLaunchReceipt>
): Promise<StructuredAgentLaunchReceipt> {
  const receipt = await launched
  if (state.sessionOptions) {
    await applyStructuredAgentLaunchOptions(state.intent, state.sessionOptions)
  }
  return receipt
}
