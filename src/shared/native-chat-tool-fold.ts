import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage
} from './native-chat-types'
import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'
import { isNoiseMessage } from './native-chat-noise'
import {
  CODEX_PLAN_UPDATED_FRAME_KIND,
  isWordlessProviderFrameMessage
} from './native-chat-provider-frame-summary'
import { FoldedToolResultSources } from './native-chat-folded-tool-results'

export { pairToolBlocks, type NativeChatToolPair } from './native-chat-tool-pairs'

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

/** Activity rows land mid-turn, between the assistant's tool calls. They are
 *  chrome, not a new turn, so they must not end the run the following tool
 *  messages fold into. */
function isSubagentRosterMessage(message: NativeChatMessage): boolean {
  return message.blocks.some(isSubagentGroupBlock)
}

function isBackgroundTaskMessage(message: NativeChatMessage): boolean {
  return message.blocks.some(isBackgroundTaskBlock)
}

/** A stored-only provider event draws nothing, so it must not split the run around it. A plan
 *  update still does: the desktop draws it in place as the task list. */
function isUndrawnProviderFrameMessage(message: NativeChatMessage): boolean {
  return (
    isWordlessProviderFrameMessage(message) &&
    !message.blocks.some(
      (block) =>
        block.type === 'text' &&
        block.providerFrame?.provider === 'codex' &&
        block.providerFrame.kind === CODEX_PLAN_UPDATED_FRAME_KIND
    )
  )
}

function isInterruptionBoundary(message: NativeChatMessage): boolean {
  return message.blocks.some(
    (block) =>
      block.type === 'text' && block.text.trim().toLowerCase().startsWith('[request interrupted')
  )
}

/** A run drawn at its assistant row can hold calls newer than rows drawn below it. */
function recordFoldedPosition(target: NativeChatMessage, folded: NativeChatMessage): void {
  if (folded.journalPosition) {
    target.foldedJournalPosition = folded.journalPosition
  }
}

/** Fold consecutive tool-only messages into their preceding assistant turn. */
export function foldToolMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  const output: NativeChatMessage[] = []
  const sources = new FoldedToolResultSources(messages)
  let mutableAssistantIndex = -1
  let clonedAssistantIndex = -1
  for (const message of messages) {
    if (message.unpairedToolResults) {
      output.push(message)
      mutableAssistantIndex = -1
      clonedAssistantIndex = -1
      continue
    }
    if (isHarnessSidecarToolMessage(message) && mutableAssistantIndex >= 0) {
      const index = mutableAssistantIndex
      const assistant = output[index]
      if (assistant?.role === 'assistant') {
        const results = message.blocks.filter(isToolResultBlock)
        sources.append(index, assistant, message, results, output.length, output.length)
        if (clonedAssistantIndex !== index) {
          output[index] = { ...assistant, blocks: [...assistant.blocks] }
          clonedAssistantIndex = index
        }
        output[index].blocks.push(...results)
        recordFoldedPosition(output[index], message)
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
      sources.append(index, assistant, message, message.blocks, output.length)
      if (clonedAssistantIndex !== index) {
        output[index] = { ...assistant, blocks: [...assistant.blocks] }
        clonedAssistantIndex = index
      }
      output[index]!.blocks.push(...message.blocks)
      recordFoldedPosition(output[index]!, message)
      continue
    }
    output.push(message)
    if (message.role === 'assistant') {
      mutableAssistantIndex = output.length - 1
      clonedAssistantIndex = -1
    } else if (
      !isSubagentRosterMessage(message) &&
      !isBackgroundTaskMessage(message) &&
      !isUndrawnProviderFrameMessage(message) &&
      (!isNoiseMessage(message) || isInterruptionBoundary(message))
    ) {
      mutableAssistantIndex = -1
      clonedAssistantIndex = -1
    }
  }
  return sources.project(output)
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
