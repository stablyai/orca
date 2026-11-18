import { createContext, useContext, useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useNativeChatTabOwnerWorktreeId } from '../../pane/ownership/use-native-chat-tab-owner'

export type NativeChatVisualOwner = {
  target: RuntimeClientTarget
  sessionId: string
  worktreeId: string
  tabId?: string
}

export const NativeChatVisualOwnerContext = createContext<NativeChatVisualOwner | null>(null)

/** Null outside a structured chat's transcript, where no visual can be read. */
export function useNativeChatVisualOwner(): NativeChatVisualOwner | null {
  return useContext(NativeChatVisualOwnerContext)
}

/** Null for a bridge chat (no target), which reads no visuals. */
export function useNativeChatTabVisualOwner(
  target: RuntimeClientTarget | null,
  sessionId: string | null,
  tabId: string
): NativeChatVisualOwner | null {
  // Until the tab's workspace is known there is no workspace to open a visual's tab in.
  const worktreeId = useNativeChatTabOwnerWorktreeId(tabId)
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const hasTarget = target !== null
  return useMemo<NativeChatVisualOwner | null>(
    () =>
      worktreeId && hasTarget && sessionId !== null
        ? {
            target:
              environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
            sessionId,
            tabId,
            worktreeId
          }
        : null,
    [environmentId, hasTarget, sessionId, tabId, worktreeId]
  )
}
