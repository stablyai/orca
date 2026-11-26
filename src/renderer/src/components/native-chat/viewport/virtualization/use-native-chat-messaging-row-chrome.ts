import { useMemo } from 'react'
import { useNativeChatMessagingStyle } from '../../appearance/use-native-chat-messaging-style'
import { nativeChatTimeDividers } from '../../conversation/slots/native-chat-time-dividers'
import {
  nativeChatSlotJoinsActivityAbove,
  nativeChatSlotJoinsMessageAbove
} from '../../conversation/slots/native-chat-activity-row-joins'
import { nativeChatSlotLeavesWhole } from '../../conversation/slots/native-chat-quiet-turn-rows'
import {
  useNativeChatTimedRows,
  type NativeChatTimedRow
} from '../../conversation/slots/native-chat-timed-rows'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'

export function useNativeChatMessagingRowChrome(
  slots: readonly NativeChatTranscriptSlot[],
  botChat: boolean,
  timedRows: readonly NativeChatTimedRow[] | undefined,
  markerIndex: number | undefined
) {
  const messaging = useNativeChatMessagingStyle() && botChat
  const placed = useNativeChatTimedRows(slots, messaging ? timedRows : undefined)
  return useMemo(() => {
    if (!messaging) {
      return undefined
    }
    const dividers = nativeChatTimeDividers(slots)
    return new Map(
      slots.map((slot, index) => {
        const input = {
          slot,
          previous: slots[index - 1],
          timedRowsAfter: placed?.afterMessage,
          markerKey: index === markerIndex && slot.kind === 'message' ? slot.message.id : undefined,
          leavesWhole: nativeChatSlotLeavesWhole(slot)
        }
        const joins =
          !dividers.has(index) &&
          !nativeChatSlotJoinsActivityAbove(input) &&
          nativeChatSlotJoinsMessageAbove(input)
        return [index, { divider: dividers.has(index), joinsAbove: joins }]
      })
    )
  }, [slots, messaging, placed, markerIndex])
}
