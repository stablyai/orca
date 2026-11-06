import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
export type HostOfferRead = {
  candidates: readonly ResumeCandidate[]
  failed: readonly ResumeFailure[]
  available: boolean
}

/** The host's answer as this side understands it. `failed` is optional on the wire: an older host
 *  never sends it, and its absence means nothing to show, not an invalid answer. */
export type HostOfferPayload = { sessions?: unknown; failed?: unknown }

export function failedFrom(payload: HostOfferPayload): ResumeFailure[] {
  // SAFETY: the host is the single writer of this shape; a malformed row is a host bug, not input.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
  return Array.isArray(payload.failed) ? (payload.failed as ResumeFailure[]) : []
}
export type NativeChatRestartOffer = Readonly<{
  candidates: readonly ResumeCandidate[]
  /** Acted-on offers whose agent did not carry on, as the host still records them. */
  failed: readonly ResumeFailure[]
  /** Stamped when the list arrived. Row ages read against this rather than a render-time
   *  `Date.now()`, so they stay stable across re-renders and the render stays pure. */
  listedAt: number
}>

export const EMPTY: NativeChatRestartOffer = { candidates: [], failed: [], listedAt: 0 }

export function restartOfferOnTarget(
  answer: NativeChatRestartOffer,
  target: RuntimeClientTarget
): NativeChatRestartOffer {
  if (target.kind === 'local') {
    return answer
  }
  const onThisHost = <T extends ResumeCandidate>(rows: readonly T[]): T[] =>
    rows.map((row) => ({ ...row, executionHostId: executionHostIdForStructuredTarget(target) }))
  return { ...answer, candidates: onThisHost(answer.candidates), failed: onThisHost(answer.failed) }
}

/** Missing methods settle quietly; transport failures leave discovery unsettled. */
export async function readRestartHostOffer(target: RuntimeClientTarget): Promise<HostOfferRead> {
  try {
    const offered = await callStructuredAgentSession<HostOfferPayload>(
      target,
      'agentSession.restartResumable'
    )
    if (!Array.isArray(offered.sessions)) {
      throw new Error('agent_session_restart_offer_invalid')
    }
    return { candidates: offered.sessions, failed: failedFrom(offered), available: true }
  } catch (error) {
    return {
      candidates: [],
      failed: [],
      available: error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
    }
  }
}

export async function dismissRestartHostOffer(
  target: RuntimeClientTarget,
  sessionIds?: readonly string[]
): Promise<NativeChatRestartOffer | null> {
  const result = await callStructuredAgentSession<HostOfferPayload>(
    target,
    'agentSession.restartResumableDismiss',
    sessionIds ? { sessionIds: [...sessionIds] } : {}
  )
  return Array.isArray(result.sessions)
    ? { candidates: result.sessions, failed: failedFrom(result), listedAt: Date.now() }
    : null
}
