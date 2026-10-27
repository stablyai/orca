// Group tool calls and finished thoughts into one collapsible run between prose rows; thinking before each call must not double the visible rows.

import { isNativeChatAskCall } from './native-chat/input/native-chat-ask-row'
import { deriveNativeChatRowContent } from './native-chat-row-content'
import { isStoppedBeforeStartBlock } from './native-chat-stopped-before-start'
import { pairToolBlocks } from './native-chat/tools/native-chat-tool-pairs'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

/** `lead`: the agent's words with calls already folded under them, which may head a run but
 *  never join one. */
export type NativeChatWorkRunMember = 'lead' | 'tool' | 'thought'

/** Only prose/plain tool activity joins runs; rosters, tasks, questions and approval receipts keep separate rows. scopeIsWorking names the owning turn/subagent’s liveness. */
export function nativeChatWorkRunMember(
  message: NativeChatMessage,
  hasReceipt: boolean,
  scopeIsWorking: boolean
): NativeChatWorkRunMember | null {
  if (hasReceipt) {
    return null
  }
  if (message.role === 'reasoning') {
    // Live thinking stays separate; ended thoughts join runs, including textless thoughts that render nothing.
    return scopeIsWorking && message.state === 'running' ? null : 'thought'
  }
  const content = deriveNativeChatRowContent(message.blocks)
  if (
    message.role !== 'assistant' ||
    content.tools.length === 0 ||
    content.subagentGroups.length > 0 ||
    content.backgroundTasks.length > 0 ||
    message.blocks.some(
      (block) => isStoppedBeforeStartBlock(block) || (block.type === 'text' && block.providerFrame)
    ) ||
    content.tools.some(isNativeChatAskCall)
  ) {
    return null
  }
  return content.markdown.length > 0 || content.hasImages ? 'lead' : 'tool'
}

/** One row of a transcript as the run boundaries read it. */
export type NativeChatWorkRunRow = {
  /** What the row adds to a run; null ends one. */
  member: NativeChatWorkRunMember | null
  /** False for a row that draws nothing: it neither joins nor ends a run. */
  draws: boolean
  /** Runs never cross a scope (a turn, a subagent's section), drawn or not. */
  scope: string | undefined
}

/** Derive ascending run-member indexes: at least two members and one call. A lead can head but never join another run. */
export function nativeChatWorkRunSpans(rows: readonly NativeChatWorkRunRow[]): number[][] {
  const spans: number[][] = []
  let open: number[] = []
  let hasCall = false
  let scope: string | undefined
  const close = (): void => {
    if (open.length > 1 && hasCall) {
      spans.push(open)
    }
    open = []
    hasCall = false
  }
  for (const [index, row] of rows.entries()) {
    if (open.length > 0 && row.scope !== scope) {
      close()
    }
    if (!row.draws) {
      continue
    }
    if (row.member === null || row.member === 'lead') {
      close()
    }
    if (row.member === null) {
      continue
    }
    if (open.length === 0) {
      scope = row.scope
    }
    open.push(index)
    hasCall ||= row.member !== 'thought'
  }
  close()
  return spans
}

export type NativeChatWorkRunEntries = {
  /** Every member's tool blocks, in order: the run's one block list. */
  blocks: NativeChatBlock[]
  /** Thoughts drawn just before a block, keyed by that block. */
  thoughtsBefore: Map<NativeChatBlock, NativeChatMessage[]>
  /** Thoughts after the run's last block. */
  thoughtsAfter: NativeChatMessage[]
}

export function nativeChatWorkRunEntries(
  members: readonly NativeChatMessage[]
): NativeChatWorkRunEntries {
  const blocks: NativeChatBlock[] = []
  const thoughtsBefore = new Map<NativeChatBlock, NativeChatMessage[]>()
  let waiting: NativeChatMessage[] = []
  for (const message of members) {
    if (message.role === 'reasoning') {
      waiting.push(message)
      continue
    }
    const { tools } = deriveNativeChatRowContent(message.blocks)
    if (tools.length === 0) {
      continue
    }
    if (waiting.length > 0) {
      thoughtsBefore.set(tools[0]!, waiting)
      waiting = []
    }
    blocks.push(...tools)
  }
  return { blocks, thoughtsBefore, thoughtsAfter: waiting }
}

/** Map message-local diff target indexes into the run’s combined edit numbering. */
export function nativeChatWorkRunEditKey(
  members: readonly NativeChatMessage[],
  runBlocks: readonly NativeChatBlock[],
  target: { messageId: string; editKey: string }
): string | null {
  const member = members.find((message) => message.id === target.messageId)
  if (!member) {
    return null
  }
  // Numbered over the raw blocks, as the turn's diff rollup numbers them.
  const call = pairToolBlocks(member.blocks).find(
    ({ call }, index) => call !== undefined && `${call.name}:${index}` === target.editKey
  )?.call
  if (!call) {
    return null
  }
  const runIndex = pairToolBlocks(runBlocks).findIndex((pair) => pair.call === call)
  return runIndex === -1 ? null : `${call.name}:${runIndex}`
}
