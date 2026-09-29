import {
  isBackgroundTaskBlock,
  isImageRefBlock,
  isSubagentGroupBlock,
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from './native-chat-types'
import { agentJournalItemSubagentId } from './agent-session-journal-producer'
import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'
import { isNoiseMessage } from './native-chat-noise'

function isToolOnlyMessage(message: NativeChatMessage): boolean {
  return (
    message.blocks.length > 0 &&
    message.blocks.every((block) => isToolCallBlock(block) || isToolResultBlock(block))
  )
}

// A tool result carrying screenshots: the result joins the run, the images stay a row of their own.
function isToolScreenshotMessage(message: NativeChatMessage): boolean {
  return (
    message.role === 'tool' &&
    message.blocks.some(isToolResultBlock) &&
    message.blocks.some(isImageRefBlock) &&
    message.blocks.every((block) => isToolResultBlock(block) || isImageRefBlock(block))
  )
}

function isHarnessSidecarToolMessage(message: NativeChatMessage): boolean {
  if (
    message.role !== 'user' ||
    isInterruptionBoundary(message) ||
    !message.blocks.some(isToolResultBlock)
  ) {
    return false
  }
  const textBlocks = message.blocks.filter((block) => block.type === 'text')
  return (
    textBlocks.length > 0 &&
    message.blocks.every(
      (block) =>
        isToolResultBlock(block) ||
        (block.type === 'text' && isKnownHarnessInjectedUserTurnText(block.text))
    )
  )
}

/** Activity rows land mid-turn, between the assistant's tool calls. They are
 *  chrome, not a new turn, so they must not end the run the following tool
 *  messages fold into. */
function isSubagentRosterMessage(message: NativeChatMessage): boolean {
  return message.blocks.some(isSubagentGroupBlock)
}

function isBackgroundTaskMessage(message: NativeChatMessage): boolean {
  return message.blocks.some(isBackgroundTaskBlock)
}

function isInterruptionBoundary(message: NativeChatMessage): boolean {
  return message.blocks.some(
    (block) =>
      block.type === 'text' && block.text.trim().toLowerCase().startsWith('[request interrupted')
  )
}

/** Drop tool results the renderer cannot pair within their folded message. */
function dropUnattributableToolResults(message: NativeChatMessage): NativeChatMessage | null {
  let blocks: NativeChatBlock[] | undefined
  let unansweredCalls = 0
  for (let index = 0; index < message.blocks.length; index++) {
    const block = message.blocks[index]
    if (isToolCallBlock(block)) {
      unansweredCalls += 1
    } else if (isToolResultBlock(block)) {
      if (unansweredCalls === 0) {
        blocks ??= message.blocks.slice(0, index)
        continue
      }
      unansweredCalls -= 1
    }
    blocks?.push(block)
  }
  if (!blocks) {
    return message
  }
  return blocks.length > 0 ? { ...message, blocks } : null
}

/** Fold consecutive tool-only messages into their preceding assistant turn.
 *  Only into a run the same agent wrote: a subagent's calls interleave with its
 *  parent's in one journal, and absorbing one into the other would present one
 *  agent's work as the other's. */
export function foldToolMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  const output: NativeChatMessage[] = []
  let mutableAssistantIndex = -1
  let clonedAssistantIndex = -1
  for (const message of messages) {
    const foldTarget =
      mutableAssistantIndex >= 0 &&
      agentJournalItemSubagentId(output[mutableAssistantIndex]) ===
        agentJournalItemSubagentId(message)
        ? mutableAssistantIndex
        : -1
    if (
      (isHarnessSidecarToolMessage(message) || isToolScreenshotMessage(message)) &&
      foldTarget >= 0
    ) {
      const index = foldTarget
      const assistant = output[index]
      if (assistant?.role === 'assistant') {
        if (clonedAssistantIndex !== index) {
          output[index] = { ...assistant, blocks: [...assistant.blocks] }
          clonedAssistantIndex = index
        }
        output[index].blocks.push(...message.blocks.filter(isToolResultBlock))
        output.push({
          ...message,
          blocks: message.blocks.filter((block) => !isToolResultBlock(block))
        })
        continue
      }
    }
    if (isToolOnlyMessage(message) && foldTarget >= 0) {
      const index = foldTarget
      const assistant = output[index]
      if (assistant?.role !== 'assistant') {
        output.push(message)
        mutableAssistantIndex = -1
        continue
      }
      if (clonedAssistantIndex !== index) {
        output[index] = { ...assistant, blocks: [...assistant.blocks] }
        clonedAssistantIndex = index
      }
      output[index]!.blocks.push(...message.blocks)
      continue
    }
    output.push(message)
    if (message.role === 'assistant') {
      mutableAssistantIndex = output.length - 1
      clonedAssistantIndex = -1
    } else if (
      !isSubagentRosterMessage(message) &&
      !isBackgroundTaskMessage(message) &&
      (!isNoiseMessage(message) || isInterruptionBoundary(message))
    ) {
      mutableAssistantIndex = -1
      clonedAssistantIndex = -1
    }
  }
  const attributedOutput: NativeChatMessage[] = []
  for (const message of output) {
    const attributed = dropUnattributableToolResults(message)
    if (attributed) {
      attributedOutput.push(attributed)
    }
  }
  return attributedOutput
}

export type NativeChatToolPair = {
  call?: NativeChatToolCallBlock
  result?: NativeChatToolResultBlock
}

/** Pair calls and results by FIFO ordinal because transcript blocks carry no tool ids. */
export function pairToolBlocks(
  blocks: readonly NativeChatBlock[],
  limit = Infinity
): NativeChatToolPair[] {
  const pairs: NativeChatToolPair[] = []
  const callSlots: number[] = []
  let resultOrdinal = 0
  for (const block of blocks) {
    if (pairs.length >= limit && resultOrdinal >= callSlots.length) {
      break
    }
    if (block.type === 'tool-call') {
      if (pairs.length < limit) {
        callSlots.push(pairs.length)
        pairs.push({ call: block })
      }
      continue
    }
    if (block.type !== 'tool-result') {
      continue
    }
    const slot = callSlots[resultOrdinal]
    if (slot === undefined) {
      if (pairs.length < limit) {
        pairs.push({ result: block })
      }
    } else {
      resultOrdinal += 1
      pairs[slot]!.result = block
    }
  }
  return pairs
}

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
