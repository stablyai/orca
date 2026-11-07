import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'

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

export function NativeChatVisualOwnerProvider({
  target,
  sessionId,
  tabId,
  children
}: {
  target: RuntimeClientTarget
  sessionId: string
  tabId: string
  children: ReactNode
}): React.JSX.Element {
  // Until the tab's workspace is known there is no workspace to open a visual's tab in.
  const worktreeId = useNativeChatTabOwnerWorktreeId(tabId)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const owner = useMemo<NativeChatVisualOwner | null>(
    () =>
      worktreeId
        ? {
            target:
              environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
            sessionId,
            tabId,
            worktreeId
          }
        : null,
    [environmentId, sessionId, tabId, worktreeId]
  )
  return (
    <NativeChatVisualOwnerContext.Provider value={owner}>
      {children}
    </NativeChatVisualOwnerContext.Provider>
  )
}
