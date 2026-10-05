import type { NativeChatAsyncQuestionsField } from './native-chat-async-questions'

/** Per-frame fields every agent-session subscribe frame may carry. */
export type AgentSessionFrameSideFields = {
  /** Host wall clock (ms epoch) stamped once per published frame; see `AgentSessionHistoryPage`. */
  hostNow?: number
  /** Host-derived pending Codex async questions from the whole journal: whole on hydration, on a
   *  batch only when changed since the last frame sent. Absent from older hosts. */
  asyncQuestions?: NativeChatAsyncQuestionsField
}
