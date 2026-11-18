import { normalizeNativeChatTaskList, type NativeChatTaskList } from './native-chat-task-list'
import type { NativeChatMessage, NativeChatToolCallBlock } from '../../native-chat-types'
import { pairToolBlocks } from '../../tools/native-chat-tool-pairs'

const snapshots = new WeakMap<NativeChatMessage, NativeChatTaskList | null>()
// Folding copies messages but keeps their blocks, so the list keeps its identity until the plan changes.
const callSnapshots = new WeakMap<NativeChatToolCallBlock, NativeChatTaskList | null>()

function callSnapshot(call: NativeChatToolCallBlock): NativeChatTaskList | null {
  if (!callSnapshots.has(call)) {
    callSnapshots.set(call, normalizeNativeChatTaskList(call.name, call.input))
  }
  return callSnapshots.get(call) ?? null
}

function latestSnapshot(message: NativeChatMessage): NativeChatTaskList | null {
  if (snapshots.has(message)) {
    return snapshots.get(message) ?? null
  }
  let list: NativeChatTaskList | null = null
  if (message.role === 'assistant') {
    for (const { call, result } of pairToolBlocks(message.blocks)) {
      if (!call || call.state === 'failed' || result?.isError) {
        continue
      }
      const snapshot = callSnapshot(call)
      if (snapshot) {
        list = snapshot
      }
    }
  }
  snapshots.set(message, list)
  return list
}

/** The plan docked above the composer: the latest accepted snapshot, gone once it is emptied. */
export function nativeChatDockedTaskList(
  messages: readonly NativeChatMessage[]
): NativeChatTaskList | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const list = latestSnapshot(messages[index])
    if (list) {
      return list.tasks.length > 0 ? list : null
    }
  }
  return null
}
