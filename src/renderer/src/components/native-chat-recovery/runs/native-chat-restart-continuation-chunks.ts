import type { ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { createRuntimeRpcAbortError } from '@/runtime/rpc/calls/abortable-runtime-environment-call'
import {
  failedFrom,
  type HostOfferRead,
  type HostOfferPayload,
  type NativeChatRestartOffer
} from '../offers/native-chat-restart-host-offer'
import {
  restartContinuationHistory,
  type RestartContinuationOutcome
} from './native-chat-restart-continuation-outcomes'

export type RestartContinuationBatchResult = {
  attempted: string[]
  continued: RestartContinuationOutcome[]
  skipped: Set<string>
  failed?: readonly ResumeFailure[]
}

/** What an action that never reached the host settles with. Read only. */
export const NO_RESTART_CONTINUATION: RestartContinuationBatchResult = {
  attempted: [],
  continued: [],
  skipped: new Set()
}

/** One immutable selection; uncertainty ends dispatch without attributing an outcome to its tail.
 *  `followHostLaunch`: the host's own launch action took the selection; wait for its answer instead. */
export async function continueRestartChunks(
  target: RuntimeClientTarget,
  requested: readonly string[],
  owner: {
    followHostLaunch?: boolean
    current: () => boolean
    publish: (offer: NativeChatRestartOffer) => void
    refresh: () => Promise<HostOfferRead>
    failures: () => readonly ResumeFailure[]
    markUnsent: (ids: readonly string[], at: number) => void
  }
): Promise<RestartContinuationBatchResult> {
  const result: RestartContinuationBatchResult = {
    attempted: [],
    continued: [],
    skipped: new Set()
  }
  const size = owner.followHostLaunch ? requested.length : 512
  for (let offset = 0; offset < requested.length && owner.current(); offset += size) {
    const chunk = requested.slice(offset, offset + size)
    result.attempted.push(...chunk)
    try {
      const answer = await callStructuredAgentSession<
        HostOfferPayload & {
          continued?: RestartContinuationOutcome[]
          skipped?: string[]
        }
      >(
        target,
        owner.followHostLaunch
          ? 'agentSession.restartLaunchSettled'
          : 'agentSession.restartContinue',
        owner.followHostLaunch ? {} : { sessionIds: chunk },
        {
          beforeSend: () => {
            if (!owner.current()) {
              throw createRuntimeRpcAbortError()
            }
          }
        }
      )
      if (!owner.current()) {
        break
      }
      const listed = Array.isArray(answer.failed) ? failedFrom(answer) : undefined
      result.failed = listed
      if (Array.isArray(answer.sessions)) {
        owner.publish({ candidates: answer.sessions, failed: listed ?? [], listedAt: Date.now() })
      } else {
        await owner.refresh()
      }
      if (!owner.current()) {
        break
      }
      for (const id of answer.skipped ?? []) {
        result.skipped.add(id)
      }
      result.continued.push(
        ...restartContinuationHistory(
          chunk.filter((id) => !result.skipped.has(id)),
          answer.continued
        )
      )
    } catch (error) {
      if (!owner.current()) {
        break
      }
      console.warn('[native-chat-resume] continuation reply unavailable', error)
      result.continued.push(
        ...chunk.map((sessionId) => ({ sessionId, outcome: 'unknown' as const }))
      )
      owner.markUnsent(chunk, Date.now())
      const read = await owner.refresh()
      if (owner.current()) {
        result.failed = read.available ? owner.failures() : undefined
      }
      break
    }
  }
  return result
}
