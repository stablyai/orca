import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { nativeChatShowsCiResultLines } from '../../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { withoutPullRequestEventRows } from '../../../../../../shared/native-chat/transcript/notices/native-chat-pull-request-event'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnRows } from './use-native-chat-turn-membership'

/** The rows the transcript draws (CI result lines leave it entirely unless shown), their turns,
 *  and the same rows as of their last change other than a streaming reply's text. */
export function useNativeChatShownRows(turnRows: NativeChatTurnRows): {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
  structureMessages: readonly NativeChatMessage[] | undefined
} {
  const showCiResultLines = useAppStore((state) => nativeChatShowsCiResultLines(state.settings))
  const shown = useMemo(
    () => (showCiResultLines ? turnRows : withoutPullRequestEventRows(turnRows)),
    [showCiResultLines, turnRows]
  )
  const { structureMessages, turnKeys } = turnRows
  // Built from the saved rows, so it and the turns it pairs with hold while a reply streams.
  const structure = useMemo(
    () =>
      !structureMessages || showCiResultLines
        ? structureMessages && { messages: structureMessages, turnKeys }
        : withoutPullRequestEventRows({ messages: structureMessages, turnKeys }),
    [showCiResultLines, structureMessages, turnKeys]
  )
  return {
    messages: shown.messages,
    turnKeys: structure?.turnKeys ?? shown.turnKeys,
    structureMessages: structure?.messages
  }
}
