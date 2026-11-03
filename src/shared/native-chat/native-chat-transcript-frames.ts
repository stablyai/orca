import type { NativeChatMessage, NativeChatTurnLifecycle } from './native-chat-types'

/** One page of a transcript, newest last; `beforeOffset` is where the next older page ends. */
export type NativeChatTranscriptPage = {
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number
}

/** A `nativeChat.subscribe` stream frame. */
export type NativeChatTranscriptFrame =
  | (Omit<NativeChatTranscriptPage, 'beforeOffset'> &
      Partial<Pick<NativeChatTranscriptPage, 'beforeOffset'>> & {
        type: 'snapshot'
        // No transcript exists yet; the window is empty but not settled history.
        pending?: true
        // The page starts at the row named by the subscribe's resumeAfter.
        resumed?: true
        error?: string
        lifecycle?: NativeChatTurnLifecycle
      })
  | (NativeChatTranscriptPage & { type: 'replacement'; lifecycle?: NativeChatTurnLifecycle })
  | { type: 'appended'; messages: NativeChatMessage[]; lifecycle?: NativeChatTurnLifecycle }
  | { type: 'end' }
  | {
      type: 'task-list'
      taskList: unknown
      subagents?: unknown
    }
