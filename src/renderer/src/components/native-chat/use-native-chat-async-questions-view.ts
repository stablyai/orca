import { useReducer } from 'react'
import {
  NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT,
  reduceNativeChatAsyncQuestionsView,
  type NativeChatAsyncQuestionsView
} from '../../../../shared/native-chat-async-questions'

/** The host-derived async questions a terminal transcript stream publishes. */
export function useNativeChatAsyncQuestionsView(): readonly [
  NativeChatAsyncQuestionsView,
  (frame: { type?: string; asyncQuestions?: unknown } | null) => void
] {
  return useReducer(reduceNativeChatAsyncQuestionsView, NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT)
}
