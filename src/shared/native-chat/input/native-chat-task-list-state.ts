import { normalizeNativeChatTaskList, type NativeChatTaskList } from './native-chat-task-list'
import type { NativeChatMessage } from '../native-chat-types'
import { pairToolBlocks } from '../tools/native-chat-tool-pairs'

const snapshots = new WeakMap<NativeChatMessage, NativeChatTaskList | null>()

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
      const snapshot = normalizeNativeChatTaskList(call.name, call.input)
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
  let list: NativeChatTaskList | null = null
  for (const message of messages) {
    const snapshot = latestSnapshot(message)
    if (snapshot) {
      list = snapshot
    }
  }
  return list && list.tasks.length > 0 ? list : null
}
