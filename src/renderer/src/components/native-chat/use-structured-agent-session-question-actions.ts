import { useEffect, useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'

export function useStructuredAgentSessionQuestionActions(
  target: RuntimeClientTarget,
  sessionId: string
) {
  const cancelEnvironmentId = target.kind === 'environment' ? target.environmentId : null
  const questionActions = useMemo(() => {
    const actionTarget: RuntimeClientTarget =
      cancelEnvironmentId === null
        ? { kind: 'local' }
        : { kind: 'environment', environmentId: cancelEnvironmentId }
    let retired = false
    const pending = new Set<AbortController>()
    const captured =
      actionTarget.kind === 'environment'
        ? getRuntimeEnvironmentRevision(actionTarget.environmentId)
        : undefined
    const revision = () => {
      if (retired) {
        throw new Error('Chat host changed')
      }
      if (actionTarget.kind === 'local') {
        return undefined
      }
      const continued =
        captured === undefined
          ? undefined
          : resolveContinuedRuntimeEnvironmentRevision(actionTarget.environmentId, captured)
      if (
        continued === undefined ||
        (continued !== getRuntimeEnvironmentRevision(actionTarget.environmentId) &&
          !isRuntimeEnvironmentContinuationPending(actionTarget.environmentId, continued))
      ) {
        throw new Error('Chat host changed')
      }
      return continued
    }
    const retire = () => {
      retired = true
      for (const controller of pending) {
        controller.abort()
      }
    }
    return {
      retain: () => {
        retired = false
      },
      retire,
      cancel: async (ids: readonly string[]) => {
        if (retired) {
          throw new Error('Chat host changed')
        }
        const controller = new AbortController()
        pending.add(controller)
        try {
          await callStructuredAgentSession(
            actionTarget,
            'agentSession.cancelCurrentQuestions',
            {
              sessionId,
              ids: [...ids]
            },
            {
              signal: controller.signal,
              timeoutMs: 15_000,
              expectedEnvironmentPairingRevision: revision(),
              beforeSend: () => {
                revision()
              }
            }
          )
          revision()
        } finally {
          pending.delete(controller)
        }
      }
    }
  }, [sessionId, cancelEnvironmentId])
  useEffect(() => {
    questionActions.retain()
    const stop =
      cancelEnvironmentId === null
        ? () => {}
        : onRuntimeEnvironmentsRetired((ids) => {
            if (ids.includes(cancelEnvironmentId)) {
              questionActions.retire()
            }
          })
    return () => {
      stop()
      questionActions.retire()
    }
  }, [cancelEnvironmentId, questionActions])
  return questionActions
}
