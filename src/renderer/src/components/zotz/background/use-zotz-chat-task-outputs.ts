import { useMemo } from 'react'
import { useNativeChatTabOwnerWorktreeId } from '@/components/native-chat/pane/ownership/use-native-chat-tab-owner'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { readZotzTaskOutputTail } from './zotz-background-task-output-read'
import {
  useZotzTaskOutputSources,
  type ZotzBackgroundTaskOutputs
} from './zotz-background-task-outputs'

/** What the Background panel needs to show a chat's shell output: its worktree and each task's output file. */
export function useZotzChatTaskOutputs(
  tabId: string,
  messages: readonly NativeChatMessage[] | undefined
): ZotzBackgroundTaskOutputs {
  const worktreeId = useNativeChatTabOwnerWorktreeId(tabId)
  const { outputFiles, callOutputs } = useZotzTaskOutputSources(messages)
  return useMemo(
    () => ({ worktreeId, outputFiles, callOutputs, read: readZotzTaskOutputTail }),
    [worktreeId, outputFiles, callOutputs]
  )
}
