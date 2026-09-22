import {
  normalizeNativeChatTaskList,
  type NativeChatTaskList
} from '../../../../shared/native-chat-task-list'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { pairToolBlocks } from './native-chat-tool-fold'

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

/** Select composer progress without consuming historical transcript updates. */
export function nativeChatTaskListState(messages: readonly NativeChatMessage[]): {
  messages: readonly NativeChatMessage[]
  list: NativeChatTaskList | null
} {
  let list: NativeChatTaskList | null = null
  for (const message of messages) {
    const snapshot = latestSnapshot(message)
    if (snapshot) {
      list = snapshot
    }
  }
  return { messages, list }
}
