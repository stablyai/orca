import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { NativeChatUsageLimitCut } from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import type { NativeChatUsageLimitAutoContinueState } from './NativeChatUsageLimitAutoContinue'

export function useNativeChatUsageLimitAutoContinue(
  target: RuntimeClientTarget,
  sessionId: string,
  cut: NativeChatUsageLimitCut | null
): NativeChatUsageLimitAutoContinueState | null {
  const capability = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY
  )
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  const knownReset = cut?.resetsAt !== undefined
  useEffect(
    () => (capability === 'supported' && knownReset ? feed.activate() : undefined),
    [capability, knownReset, feed]
  )
  const summary = useSyncExternalStore(feed.subscribe, () => feed.getSnapshot().get(sessionId))
  const [cancelling, setCancelling] = useState(false)
  const state = summary?.usageLimitContinue
  if (
    capability !== 'supported' ||
    cut?.resetsAt === undefined ||
    state?.turnItemId !== cut.turnItemId ||
    state.resetsAt !== cut.resetsAt
  ) {
    return null
  }
  if (state.state === 'off') {
    return target.kind === 'local' ? { kind: 'off' } : null
  }
  if (state.state !== 'scheduled') {
    return { kind: 'cancelled' }
  }
  return {
    kind: 'scheduled',
    resetsAt: state.resetsAt,
    cancelDisabled: cancelling,
    cancel: () => {
      const current = feed.getSnapshot().get(sessionId)?.usageLimitContinue
      if (
        cancelling ||
        current?.state !== 'scheduled' ||
        current.turnItemId !== state.turnItemId ||
        current.resetsAt !== state.resetsAt
      ) {
        return
      }
      setCancelling(true)
      void callStructuredAgentSession(target, 'agentSession.cancelUsageLimitContinue', {
        sessionId,
        turnItemId: state.turnItemId,
        resetsAt: state.resetsAt
      })
        .catch(() => {
          toast.error(
            translate(
              'components.native-chat.usageLimitAutoContinue.cancelFailed',
              "Couldn't cancel automatic continuation. Try again."
            )
          )
        })
        .finally(() => setCancelling(false))
    }
  }
}
