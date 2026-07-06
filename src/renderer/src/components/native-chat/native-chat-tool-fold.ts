// Pure folding logic for the native chat tool runs. Claude emits each tool call
// as its own assistant message and each result as a tool-role message; folding
// every tool-only message into the preceding assistant turn lets the view
// collapse a whole turn's tool activity under one "N tool calls" line. Kept out
// of the .tsx so the merge/split rules are unit-testable without rendering.
// Ported from the mobile foldToolMessages/splitNativeChatBlocks (mobile parity).

import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'

/** True when a message carries nothing but tool calls/results — the shape Claude
 *  emits for the tool half of a turn. */
function isToolOnlyMessage(message: NativeChatMessage): boolean {
  return (
    message.blocks.length > 0 &&
    message.blocks.every((block) => isToolCallBlock(block) || isToolResultBlock(block))
  )
}

/** Fold a turn's tool activity into the assistant message it belongs to, so the
 *  view can collapse a whole turn's tools under one line. A tool-only message is
 *  merged into the preceding assistant turn when one exists; otherwise it stands
 *  on its own (e.g. an orphan result with no preceding assistant prose). */
export function foldToolMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  const out: NativeChatMessage[] = []
  for (const message of messages) {
    const prev = out.at(-1)
    if (isToolOnlyMessage(message) && prev && prev.role === 'assistant') {
      out[out.length - 1] = { ...prev, blocks: [...prev.blocks, ...message.blocks] }
    } else {
      out.push(message)
    }
  }
  return out
}

/** Split a message's blocks into prose (text/image) and tool (call/result), so
 *  the view renders the agent's words first and folds the tool activity into a
 *  separate collapsible run beneath it. */
export function splitNativeChatBlocks(blocks: readonly NativeChatBlock[]): {
  prose: NativeChatBlock[]
  tools: NativeChatBlock[]
} {
  const prose: NativeChatBlock[] = []
  const tools: NativeChatBlock[] = []
  for (const block of blocks) {
    if (isToolCallBlock(block) || isToolResultBlock(block)) {
      tools.push(block)
    } else {
      prose.push(block)
    }
  }
  return { prose, tools }
}
