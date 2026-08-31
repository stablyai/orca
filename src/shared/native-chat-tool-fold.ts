import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from './native-chat-types'
import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'
import { isNoiseMessage } from './native-chat-noise'

function isToolOnlyMessage(message: NativeChatMessage): boolean {
  return (
    message.blocks.length > 0 &&
    message.blocks.every((block) => isToolCallBlock(block) || isToolResultBlock(block))
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

function isInterruptionBoundary(message: NativeChatMessage): boolean {
  return message.blocks.some(
    (block) =>
      block.type === 'text' && block.text.trim().toLowerCase().startsWith('[request interrupted')
  )
}

/** Drop tool results the renderer cannot pair within their folded message. */
function dropUnattributableToolResults(message: NativeChatMessage): NativeChatMessage | null {
  const blocks: NativeChatBlock[] = []
  let unansweredCalls = 0
  for (const block of message.blocks) {
    if (isToolCallBlock(block)) {
      unansweredCalls += 1
    } else if (isToolResultBlock(block)) {
      if (unansweredCalls === 0) {
        continue
      }
      unansweredCalls -= 1
    }
    blocks.push(block)
  }
  if (blocks.length === message.blocks.length) {
    return message
  }
  return blocks.length > 0 ? { ...message, blocks } : null
}

/** Fold consecutive tool-only messages into their preceding assistant turn. */
export function foldToolMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  const output: NativeChatMessage[] = []
  let mutableAssistantIndex = -1
  let clonedAssistantIndex = -1
  for (const message of messages) {
    if (isHarnessSidecarToolMessage(message) && mutableAssistantIndex >= 0) {
      const index = mutableAssistantIndex
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
    if (isToolOnlyMessage(message) && mutableAssistantIndex >= 0) {
      const index = mutableAssistantIndex
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
    } else if (!isNoiseMessage(message) || isInterruptionBoundary(message)) {
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
  const callSlots: (number | null)[] = []
  let resultOrdinal = 0
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      if (pairs.length < limit) {
        callSlots.push(pairs.length)
        pairs.push({ call: block })
      } else {
        callSlots.push(null)
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
      if (slot !== null) {
        pairs[slot]!.result = block
      }
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
