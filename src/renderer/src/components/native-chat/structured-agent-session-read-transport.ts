import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired,
  isRuntimeEnvironmentContinuationPending
} from '@/runtime/runtime-environment-revision'
import { startStructuredAgentSessionLiveRead } from '../../../../shared/structured-agent-session-live-read'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  callStructuredAgentSession,
  subscribeStructuredAgentSession
} from '@/runtime/structured-agent-session-client'

type LiveReadArgs = Parameters<typeof startStructuredAgentSessionLiveRead>[0]

export function startStructuredAgentSessionReadTransport(
  args: Omit<LiveReadArgs, 'readCurrentRequests' | 'subscribe'> & {
    target: RuntimeClientTarget
    onRetired?: () => void
  }
): ReturnType<typeof startStructuredAgentSessionLiveRead> {
  const { target, onRetired, ...read } = args
  const capturedRevision =
    target.kind === 'environment' ? getRuntimeEnvironmentRevision(target.environmentId) : undefined
  let retired = false
  const revision = (): number | undefined => {
    if (retired) {
      throw new Error('Chat host changed')
    }
    if (target.kind === 'local') {
      return undefined
    }
    const continued =
      capturedRevision === undefined
        ? undefined
        : resolveContinuedRuntimeEnvironmentRevision(target.environmentId, capturedRevision)
    if (
      continued === undefined ||
      (continued !== getRuntimeEnvironmentRevision(target.environmentId) &&
        !isRuntimeEnvironmentContinuationPending(target.environmentId, continued))
    ) {
      throw new Error('Chat host changed')
    }
    return continued
  }
  let live: ReturnType<typeof startStructuredAgentSessionLiveRead> | undefined
  const stopRetirement =
    target.kind === 'environment'
      ? onRuntimeEnvironmentsRetired((ids) => {
          if (!ids.includes(target.environmentId)) {
            return
          }
          retired = true
          live?.dispose()
          args.onContactLost()
          onRetired?.()
        })
      : () => {}
  live = startStructuredAgentSessionLiveRead({
    ...read,
    readCurrentRequests: async (request, signal) => {
      const result = await callStructuredAgentSession<
        Awaited<ReturnType<LiveReadArgs['readCurrentRequests']>>
      >(target, 'agentSession.currentRequests', request, {
        signal,
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: revision(),
        beforeSend: () => {
          revision()
        }
      })
      revision()
      return result
    },
    subscribe: (params, onEvent, onError, onClose) =>
      subscribeStructuredAgentSession(
        target,
        params,
        (event) => {
          try {
            revision()
          } catch {
            return
          }
          onEvent(event)
        },
        onError,
        onClose,
        revision()
      )
  })
  const ownedLive = live
  if (retired) {
    ownedLive.dispose()
  }
  return {
    ...ownedLive,
    dispose: () => {
      stopRetirement()
      ownedLive.dispose()
    }
  }
}
