import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-create-capabilities'
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
  const turnItemId = cut?.turnItemId
  const resetsAt = cut?.resetsAt
  const knownReset = resetsAt !== undefined
  useEffect(
    () => (capability === 'supported' && knownReset ? feed.activate() : undefined),
    [capability, knownReset, feed]
  )
  // Select one primitive: every status event replaces the summary, and the notice rows read this.
  const readCutState = useCallback(() => {
    const current = feed.getSnapshot().get(sessionId)?.usageLimitContinue
    return resetsAt !== undefined &&
      current?.turnItemId === turnItemId &&
      current.resetsAt === resetsAt
      ? current.state
      : undefined
  }, [feed, sessionId, turnItemId, resetsAt])
  const cutState = useSyncExternalStore(feed.subscribe, readCutState)
  const [cancelling, setCancelling] = useState(false)
  const cancel = useCallback(() => {
    // Read the feed now: the schedule may have changed since this row last rendered.
    if (
      cancelling ||
      turnItemId === undefined ||
      resetsAt === undefined ||
      readCutState() !== 'scheduled'
    ) {
      return
    }
    setCancelling(true)
    void callStructuredAgentSession(target, 'agentSession.cancelUsageLimitContinue', {
      sessionId,
      turnItemId,
      resetsAt
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
  }, [cancelling, readCutState, target, sessionId, turnItemId, resetsAt])
  return useMemo<NativeChatUsageLimitAutoContinueState | null>(() => {
    if (capability !== 'supported' || resetsAt === undefined || cutState === undefined) {
      return null
    }
    if (cutState === 'off') {
      return target.kind === 'local' ? { kind: 'off' } : null
    }
    if (cutState !== 'scheduled') {
      return { kind: 'cancelled' }
    }
    return { kind: 'scheduled', resetsAt, cancelDisabled: cancelling, cancel }
  }, [capability, resetsAt, cutState, target.kind, cancelling, cancel])
}
