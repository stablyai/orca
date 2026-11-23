import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { nativeChatShowsCiResultLines } from '../../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { withoutPullRequestEventRows } from '../../../../../../shared/native-chat/transcript/notices/native-chat-pull-request-event'

type NativeChatTurnRows = Parameters<typeof withoutPullRequestEventRows>[0]

/** Hidden CI lines leave the transcript entirely, so they reserve no row or gap. */
export function useNativeChatCiLineRows(turnRows: NativeChatTurnRows): NativeChatTurnRows {
  const showCiResultLines = useAppStore((state) => nativeChatShowsCiResultLines(state.settings))
  return useMemo(
    () => (showCiResultLines ? turnRows : withoutPullRequestEventRows(turnRows)),
    [showCiResultLines, turnRows]
  )
}
