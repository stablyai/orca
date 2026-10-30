import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { StructuredChatTabNamingFailure } from '@/runtime/structured-conversation-name'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { regenerateStructuredAgentSessionName } from '@/runtime/structured-agent-session-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { nativeChatNamingErrorText } from './native-chat-naming-failure-copy'

const noSubscription = () => () => {}

export type NativeChatNamingFailureControls = {
  message: string
  /** Known before the card opens: the host check starts when the failure arrives. */
  canRegenerate: boolean
  regenerating: boolean
  regenerate: () => void
  dialogOpen: boolean
  setDialogOpen: (open: boolean) => void
  readFullOutput: () => Promise<string | null>
}

/** What a chat tab offers for its failed name: the error, its dialog, and Regenerate name. */
export function useNativeChatNamingFailure(
  failure: StructuredChatTabNamingFailure | null | undefined
): NativeChatNamingFailureControls | null {
  const executionHostId = failure?.executionHostId ?? null
  const sessionId = failure?.sessionId
  const failedAt = failure?.error.failedAt
  const [dialogOpen, setDialogOpen] = useState(false)
  const failing = failure !== null && failure !== undefined
  const target = useMemo(
    () => (failing ? structuredAgentSessionTargetForHost(executionHostId) : null),
    [executionHostId, failing]
  )
  const support = useStructuredAgentSessionHostCapabilityState(
    target,
    STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY
  )
  const feed = useMemo(
    () => (target ? getStructuredAgentSessionStatusFeed(target) : null),
    [target]
  )
  useEffect(() => feed?.activate(), [feed])
  const regenerating = useSyncExternalStore(
    feed?.subscribe ?? noSubscription,
    () => (sessionId ? (feed?.getNamingActive(sessionId) ?? null) : null),
    () => null
  )
  const regenerate = useCallback(() => {
    if (target && sessionId && support === 'supported') {
      void regenerateStructuredAgentSessionName(target, sessionId)
    }
  }, [target, support, sessionId])
  const readFullOutput = useCallback(async () => {
    // The full output never leaves the host that ran the agent; a paired one shows the message.
    const local = structuredAgentSessionTargetForHost(executionHostId)?.kind === 'local'
    return local && sessionId
      ? window.api.nativeChat.getConversationNameFailureOutput(sessionId)
      : null
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- A new diagnostic must reload output even when its message is unchanged.
  }, [executionHostId, sessionId, failedAt])
  if (!failure) {
    return null
  }
  return {
    message: nativeChatNamingErrorText(failure.error),
    canRegenerate: support === 'supported',
    regenerating: regenerating === true,
    regenerate,
    dialogOpen,
    setDialogOpen,
    readFullOutput
  }
}
