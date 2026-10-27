import { nativeChatAskRunBlocks } from '../input/native-chat-ask-row'
import { isToolCallBlock, type NativeChatBlock } from '../../native-chat-types'
import { describeLatestToolCall, selectActiveToolCall } from './native-chat-tool-activity'
import { nativeChatToolRunIconName, type NativeChatToolIconName } from './native-chat-tool-icon'
import {
  nativeChatToolRunOutcome,
  type NativeChatToolRunOutcome
} from './native-chat-tool-run-outcome'
import { countToolCalls } from './native-chat-tool-summary'

/** `NATIVE_CHAT_TOOL_ACTIVITY_COPY` key for a run with no per-tool sentence. */
export type NativeChatToolRunFallbackLabel = 'result' | 'countOne' | 'countN'

export type NativeChatToolRunHeader = NativeChatToolRunOutcome & {
  asks: NativeChatBlock[]
  /** Blocks the header summarizes: asks render as their own row. */
  work: NativeChatBlock[]
  askIsActive: boolean
  live: boolean
  callCount: number
  fallbackLabel: NativeChatToolRunFallbackLabel
  latestCallLabel: string | null
  iconName: NativeChatToolIconName | null
}

export function nativeChatToolRunHeader(
  blocks: NativeChatBlock[],
  context: {
    activeTurnIsWorking?: boolean
    trailing?: boolean
    /** An ask split off before these blocks arrived is still waiting. */
    askPending?: boolean
  }
): NativeChatToolRunHeader {
  const { activeTurnIsWorking, trailing } = context
  const { asks, unansweredAsks, work } = nativeChatAskRunBlocks(blocks)
  const askIsActive =
    context.askPending === true ||
    selectActiveToolCall(unansweredAsks, { activeTurnIsWorking }) !== null
  // Keep the trailing run live between calls; without a running unblocked turn, fall back to call state.
  const live =
    activeTurnIsWorking === true && !askIsActive
      ? trailing !== false
      : selectActiveToolCall(work, { activeTurnIsWorking }) !== null
  const callCount = countToolCalls(work)
  // Keep the latest call named between calls, even if it finished within one frame.
  const latestCall = live ? work.findLast(isToolCallBlock) : undefined
  return {
    ...nativeChatToolRunOutcome(work, { activeTurnIsWorking }),
    asks,
    work,
    askIsActive,
    live,
    callCount,
    fallbackLabel: callCount === 0 ? 'result' : callCount === 1 ? 'countOne' : 'countN',
    latestCallLabel: latestCall ? describeLatestToolCall(latestCall) : null,
    // Whole-run category; completion state belongs to the trailing mark.
    iconName: nativeChatToolRunIconName(work.filter(isToolCallBlock))
  }
}
