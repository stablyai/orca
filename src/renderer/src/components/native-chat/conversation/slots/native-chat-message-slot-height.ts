import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics
} from '../../viewport/virtualization/native-chat-row-height-estimate'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import type { NativeChatMessageSlot } from './native-chat-transcript-slots'

/** A message slot's own height estimate, before joins and hanging controls adjust it. */
export function nativeChatMessageSlotHeight(
  message: NativeChatMessage,
  slot: Pick<
    NativeChatMessageSlot,
    'receipt' | 'status' | 'turnDiff' | 'openedPullRequests' | 'folded'
  >,
  typography: NativeChatTranscriptSlotsInput['typography']
): number {
  return estimateNativeChatRowHeight(
    nativeChatRowContentMetrics(message, typography),
    {
      hasReceipt: slot.receipt !== undefined,
      hasStatus: slot.status !== undefined,
      hasTurnDiff: slot.turnDiff !== undefined,
      turnDiffFileCount: slot.turnDiff?.files.length,
      hasOpenedPullRequests: (slot.openedPullRequests?.length ?? 0) > 0,
      folded: slot.folded
    },
    typography
  )
}
