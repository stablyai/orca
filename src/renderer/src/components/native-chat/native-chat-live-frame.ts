import type { NativeChatSubscriptionFrame } from '../../../../preload/api-types'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatTaskSeedList } from '../../../../shared/native-chat/input/native-chat-claude-task-updates'
import {
  applyAppend,
  replaceList,
  type NativeChatMerger
} from '../../../../shared/native-chat/native-chat-merge'
import type { ReadState } from './native-chat-live-session-contract'
import type { NativeChatReadRetryTimer } from './native-chat-read-retry-timer'

export type NativeChatLiveFrameSink = {
  setTaskList: (list: NativeChatTaskSeedList | null) => void
  epochRef: { current: number }
  setOlderHistoryGeneration: (generation: number) => void
  setLoadingEarlier: (loading: boolean) => void
  setRead: (read: ReadState) => void
  setAppended: (messages: NativeChatMessage[]) => void
  setHasMore: (hasMore: boolean) => void
  appendMerger: NativeChatMerger
  limitRef: { current: number }
  retryTimer: NativeChatReadRetryTimer
  lifecycle: {
    replace: (lifecycle: NativeChatTurnLifecycle | undefined) => void
    append: (lifecycle: NativeChatTurnLifecycle | undefined) => void
  }
  flags: { frameArrived: boolean; transcriptPending: boolean }
}

/** Apply one subscribe frame. Task-list frames never start a transcript generation. */
export function applyNativeChatLiveFrame(
  frame: NativeChatSubscriptionFrame,
  sink: NativeChatLiveFrameSink
): void {
  if (frame.type === 'task-list') {
    sink.setTaskList(frame.taskList)
    return
  }
  if (frame.type === 'snapshot' || frame.type === 'replacement') {
    // Snapshots and inode replacements start a generation stale pagination must not repaint.
    sink.epochRef.current += 1
    sink.setOlderHistoryGeneration(sink.epochRef.current)
    sink.setLoadingEarlier(false)
    if (frame.type === 'replacement') {
      sink.setTaskList(null)
    }
    if ('error' in frame && frame.error) {
      // Error frames carry no transcript; leave the independent seed eligible to repair the pane.
      sink.setRead({ phase: 'error', error: frame.error })
      return
    }
    if (frame.type === 'snapshot' && frame.pending === true) {
      // Pending ends the spinner without consuming the in-flight seed or appended tail.
      sink.flags.transcriptPending = true
      sink.retryTimer.cancel()
      sink.setRead({ phase: 'awaiting' })
      return
    }
    sink.flags.frameArrived = true
    sink.lifecycle.replace(frame.lifecycle)
    replaceList(sink.appendMerger, frame.messages)
    sink.setAppended([])
    sink.setRead({ phase: 'ready', messages: sink.appendMerger.list })
    sink.setHasMore(frame.hasMore)
    return
  }
  sink.lifecycle.append(frame.lifecycle)
  // Bound the deduped append tail; the base read still covers trimmed turns.
  sink.setAppended(applyAppend(sink.appendMerger, frame.messages, sink.limitRef.current))
}
