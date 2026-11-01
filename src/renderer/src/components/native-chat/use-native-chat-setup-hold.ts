import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react'
import { useAppStore } from '@/store'
import { structuredChatTabById } from '@/lib/structured-chat-tab-index'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { structuredAgentSessionOwnerInputs } from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

/** Each chat mounts this 2-3 times; resolve its owner only when the resolver's inputs change. */
export function createNativeChatSetupHoldEnvironmentSelector(
  workspaceId: string | null,
  hostId: ExecutionHostId | undefined
) {
  let inputs: unknown[] | null = null
  let environmentId: string | null | undefined
  return (state: AppState): string | null | undefined => {
    if (!workspaceId) {
      return undefined
    }
    const next = structuredAgentSessionOwnerInputs(state)
    if (!inputs || next.some((value, index) => value !== inputs?.[index])) {
      const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId, hostId })
      environmentId = owner.kind === 'resolved' ? owner.environmentId : undefined
      inputs = next
    }
    return environmentId
  }
}

export function useNativeChatSetupHold(tabId: string) {
  const worktreeId = useNativeChatTabOwnerWorktreeId(tabId)
  const executionHostId = useAppStore((state) =>
    worktreeId
      ? structuredChatTabById(state.unifiedTabsByWorktree, worktreeId, tabId)?.executionHostId
      : undefined
  )
  const selectEnvironmentId = useMemo(
    () => createNativeChatSetupHoldEnvironmentSelector(worktreeId, executionHostId),
    [worktreeId, executionHostId]
  )
  const environmentId = useAppStore(selectEnvironmentId)
  const feed = useMemo(
    () =>
      environmentId === undefined
        ? null
        : getStructuredAgentSessionStatusFeed(runtimeTargetForOwnerEnvironment(environmentId)),
    [environmentId]
  )
  useEffect(() => feed?.activate(), [feed])
  const subscribe = useCallback(
    (listener: () => void) =>
      worktreeId && feed ? feed.subscribeWorkspaceSetupHold(worktreeId, listener) : () => {},
    [feed, worktreeId]
  )
  const read = useCallback(
    () => (worktreeId && feed ? feed.isWorkspaceSetupHeld(worktreeId) : false),
    [feed, worktreeId]
  )
  const current = useRef(read)
  // Publish only committed readers, so a retained send handler reads the current workspace.
  useLayoutEffect(() => {
    current.current = read
  }, [read])
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
