import { useAppStore } from '../store'
import {
  captureNativeChatComposerFocusIntent,
  type NativeChatComposerFocusIntent
} from '@/components/native-chat/use-native-chat-composer-reveal-focus'

/** Where a new-agent-tab shortcut was pressed: the pane it targets and the focus it may take. */
export type AgentTabLaunchContext = {
  groupId: string | undefined
  focusIntent: NativeChatComposerFocusIntent
}

export function captureAgentTabLaunchContext(worktreeId: string): AgentTabLaunchContext {
  const state = useAppStore.getState()
  return {
    groupId:
      state.activeGroupIdByWorktree[worktreeId] ?? state.groupsByWorktree[worktreeId]?.[0]?.id,
    focusIntent: captureNativeChatComposerFocusIntent()
  }
}
