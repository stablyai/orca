import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { useNow } from '@/hooks/use-now'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-create-capabilities'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  isNativeChatUsageLimitCutSchedulable,
  type NativeChatUsageLimitCut
} from '../../../../../shared/native-chat/native-chat-usage-limit-cut'
import {
  nativeChatUsageLimitAutoContinueKind,
  usageLimitContinueStateForCut
} from '../../../../../shared/native-chat/native-chat-usage-limit-auto-continue'
import type { NativeChatUsageLimitAutoContinueState } from './NativeChatUsageLimitAutoContinue'

const invalidatedByClock = (): (() => void) => () => {}

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
  const readCutState = useCallback(
    () =>
      turnItemId === undefined
        ? undefined
        : usageLimitContinueStateForCut(feed.getSnapshot().get(sessionId)?.usageLimitContinue, {
            turnItemId,
            resetsAt
          }),
    [feed, sessionId, turnItemId, resetsAt]
  )
  const subscribe = useCallback(
    (listener: () => void) => feed.subscribeSession(sessionId, listener),
    [feed, sessionId]
  )
  const cutState = useSyncExternalStore(subscribe, readCutState)
  const turnEndedAt = cut?.turnEndedAt
  // A row on screen when its cut ages out hides the automatic line; the host alone decides sends.
  // The shared minute clock only re-renders; fresh wall time decides, read on every render.
  const schedulable = useSyncExternalStore(
    invalidatedByClock,
    () =>
      turnItemId !== undefined &&
      isNativeChatUsageLimitCutSchedulable({ turnItemId, resetsAt, turnEndedAt }, Date.now())
  )
  useNow(60_000, capability === 'supported' && cutState !== undefined && schedulable)
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
    const kind =
      capability === 'supported'
        ? nativeChatUsageLimitAutoContinueKind(cutState, {
            schedulable,
            localHost: target.kind === 'local'
          })
        : null
    if (kind === null || resetsAt === undefined) {
      return null
    }
    return kind === 'scheduled' ? { kind, resetsAt, cancelDisabled: cancelling, cancel } : { kind }
  }, [capability, resetsAt, cutState, schedulable, target.kind, cancelling, cancel])
}
