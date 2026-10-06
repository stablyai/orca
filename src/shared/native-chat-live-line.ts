// The live turn's tail line, as desktop and mobile both draw it: whether it draws, what it says,
// and which open reasoning block it discloses. One value, so a block's row is hidden exactly while
// the line that shows it draws.

import {
  selectNativeChatLiveReasoning,
  type NativeChatLiveReasoning
} from './native-chat-reasoning-row'
import type { NativeChatMessage } from './native-chat-types'

export type NativeChatLiveLine = {
  /** The turn is reasoning now; the label reads "Thinking" unless activity text outranks it. */
  thinking: boolean
  activityText: string | null
  /** The open block the line discloses; its row draws nothing meanwhile. */
  reasoning: NativeChatLiveReasoning | null
}

export function nativeChatLiveLine(input: {
  /** The running turn's tail is the activity line: nothing (a prompt the reader owes) replaces it. */
  draws: boolean
  thinking: boolean
  activityText?: string | null
  messages: readonly NativeChatMessage[]
  inLiveWorkingTurn: (index: number) => boolean
}): NativeChatLiveLine | null {
  if (!input.draws) {
    return null
  }
  return {
    thinking: input.thinking,
    activityText: input.activityText ?? null,
    // Rows never say "Thinking", so the line discloses only while it is the one that does.
    reasoning: input.thinking
      ? selectNativeChatLiveReasoning(input.messages, input.inLiveWorkingTurn)
      : null
  }
}
