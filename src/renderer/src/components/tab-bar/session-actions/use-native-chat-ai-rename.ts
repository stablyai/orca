import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { regenerateStructuredAgentSessionName } from '@/runtime/native-chat/naming/structured-agent-session-name-regeneration'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import type { NativeChatTabSession } from './tab-session-history-switch'

const noSubscription = () => () => {}

export type NativeChatAiRenameControls = {
  rename: () => void
  renaming: boolean
}

/** Person-asked regenerate-name for a native chat tab, when its host supports it. */
export function useNativeChatAiRename(
  nativeChat: NativeChatTabSession | undefined,
  worktreeId: string
): NativeChatAiRenameControls | null {
  const sessionId = nativeChat?.sessionId
  const executionHostId = nativeChat?.executionHostId
  const owner = useAppStateValue((state) =>
    nativeChat ? structuredAgentSessionOwnerForTab(state, { worktreeId, executionHostId }) : null
  )
  const target = useMemo(
    () => (sessionId ? structuredAgentSessionTargetForHost(owner) : null),
    [owner, sessionId]
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
  const subscribe = useCallback(
    (listener: () => void) =>
      feed && sessionId ? feed.subscribeSession(sessionId, listener) : noSubscription(),
    [feed, sessionId]
  )
  const regenerating = useSyncExternalStore(
    subscribe,
    () => (sessionId ? (feed?.getNamingActive(sessionId) ?? null) : null),
    () => null
  )
  const rename = useCallback(() => {
    if (target && sessionId && support === 'supported') {
      void regenerateStructuredAgentSessionName(target, sessionId)
    }
  }, [target, support, sessionId])
  if (!sessionId || support !== 'supported') {
    return null
  }
  return { rename, renaming: regenerating === true }
}
