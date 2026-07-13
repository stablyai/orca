export const NATIVE_CHAT_SUBMIT_DELAY_MS = 500
export const NATIVE_CHAT_ADVANCE_BUFFER_MS = 300
export const NATIVE_CHAT_QUESTION_STEP_MS =
  NATIVE_CHAT_SUBMIT_DELAY_MS + NATIVE_CHAT_ADVANCE_BUFFER_MS

export function nativeChatQuestionOffsets(index: number): { bodyAt: number; enterAt: number } {
  const bodyAt = index * NATIVE_CHAT_QUESTION_STEP_MS
  return { bodyAt, enterAt: bodyAt + NATIVE_CHAT_SUBMIT_DELAY_MS }
}

/** Schedule one body and one Enter per question; callers own the actual transport. */
export function scheduleNativeChatAnswer(
  lines: readonly string[],
  writeBody: (line: string) => void,
  writeEnter: () => void
): ReturnType<typeof setTimeout>[] {
  const timers: ReturnType<typeof setTimeout>[] = []
  lines.forEach((line, index) => {
    const { bodyAt, enterAt } = nativeChatQuestionOffsets(index)
    timers.push(setTimeout(() => writeBody(line), bodyAt))
    timers.push(setTimeout(writeEnter, enterAt))
  })
  return timers
}
