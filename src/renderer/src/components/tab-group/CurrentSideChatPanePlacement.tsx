import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { useStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { groupCurrentSideChats } from '../native-chat/messages/actions/current-side-chat-launch'

/** Retained host naming can arrive after the workspace or grouping preference opens. */
export function CurrentSideChatPanePlacement({ worktreeId }: { worktreeId: string }) {
  const enabled = useAppStore((state) => state.settings?.nativeChatSideChatPane === true)
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree[worktreeId])
  const names = useStructuredChatTabNames()
  useEffect(() => {
    if (enabled) {
      groupCurrentSideChats(worktreeId)
    }
  }, [enabled, tabs, names, worktreeId])
  return null
}
