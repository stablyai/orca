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

/** Whether the chat below it may take reader actions like editing a reply's code block; false in
 *  a dimmed split group, whose pane stays interactive but is not the one being read. */
export const NativeChatVisualEditingContext = createContext(true)

/** True outside a chat (where it is irrelevant) and in the focused chat; false when dimmed. */
export function useNativeChatVisualEditingAllowed(): boolean {
  return useContext(NativeChatVisualEditingContext)
}
/** Null outside a structured chat's transcript, where no visual can be read. */
export function useNativeChatVisualOwner(): NativeChatVisualOwner | null {
  return useContext(NativeChatVisualOwnerContext)
}

export function NativeChatVisualOwnerProvider({
  target,
  sessionId,
  tabId,
  isFocusedGroup,
  children
}: {
  target: RuntimeClientTarget
  sessionId: string
  tabId: string
  isFocusedGroup: boolean
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
      <NativeChatVisualEditingContext.Provider value={isFocusedGroup}>
        {children}
      </NativeChatVisualEditingContext.Provider>
    </NativeChatVisualOwnerContext.Provider>
  )
}
