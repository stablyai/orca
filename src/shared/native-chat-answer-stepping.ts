export const NATIVE_CHAT_SUBMIT_DELAY_MS = 500
// 500ms (not a tighter cadence) so the next AskUserQuestion step still renders
// before its body is written on slower machines / under SSH round-trip latency.
export const NATIVE_CHAT_ADVANCE_BUFFER_MS = 500
export const NATIVE_CHAT_QUESTION_STEP_MS =
  NATIVE_CHAT_SUBMIT_DELAY_MS + NATIVE_CHAT_ADVANCE_BUFFER_MS
