import { createContext } from 'react'
import type { NativeChatAsyncQuestionReply } from '../../../../shared/native-chat-async-questions'
export type { NativeChatAsyncQuestionReply } from '../../../../shared/native-chat-async-questions'

export const NativeChatAsyncQuestionContext = createContext<NativeChatAsyncQuestionReply | null>(
  null
)
