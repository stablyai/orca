import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { structuredChatTabById } from '@/lib/structured-chat-tab-index'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'

export function useNativeChatSetupHold(tabId: string) {
  const worktreeId = useNativeChatTabOwnerWorktreeId(tabId)
  const executionHostId = useAppStore((state) =>
    worktreeId
      ? structuredChatTabById(state.unifiedTabsByWorktree, worktreeId, tabId)?.executionHostId
      : undefined
  )
  const environmentId = useAppStore((state) => {
    if (!worktreeId) {
      return undefined
    }
    const hostId = executionHostId
    const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId, hostId })
    return owner.kind === 'resolved' ? owner.environmentId : undefined
  })
  const feed = useMemo(
    () =>
      environmentId === undefined
        ? null
        : getStructuredAgentSessionStatusFeed(runtimeTargetForOwnerEnvironment(environmentId)),
    [environmentId]
  )
  useEffect(() => feed?.activate(), [feed])
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : () => {}),
    [feed]
  )
  const read = useCallback(
    () => (worktreeId && feed ? feed.isWorkspaceSetupHeld(worktreeId) : false),
    [feed, worktreeId]
  )
  const current = useRef(read)
  current.current = read
  const readHeld = useCallback(() => current.current() !== false, [])
  const observed = useSyncExternalStore(subscribe, read, read)
  return {
    held: observed === true,
    inputHeld: observed !== false,
    readHeld,
    worktreeId,
    executionHostId
  }
}
