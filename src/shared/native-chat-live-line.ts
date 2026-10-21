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
  /** The person's Stop is ending the turn: the label reads "Stopping…" and discloses no block. */
  stopping: boolean
  activityText: string | null
  /** The open block the line discloses; its row draws nothing meanwhile. */
  reasoning: NativeChatLiveReasoning | null
}

export function nativeChatLiveLine(input: {
  /** The running turn's tail is the activity line: nothing (a prompt the reader owes) replaces it. */
  draws: boolean
  thinking: boolean
  stopping?: boolean
  activityText?: string | null
  messages: readonly NativeChatMessage[]
  inLiveWorkingTurn: (index: number) => boolean
}): NativeChatLiveLine | null {
  if (!input.draws) {
    return null
  }
  const stopping = input.stopping === true
  return {
    thinking: input.thinking,
    stopping,
    activityText: input.activityText ?? null,
    // Rows never say "Thinking", so the line discloses only while it is the one that does.
    reasoning:
      input.thinking && !stopping
        ? selectNativeChatLiveReasoning(input.messages, input.inLiveWorkingTurn)
        : null
  }
}
