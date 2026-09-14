/** True for either spelling accepted by supported question-tool payloads. */
export function isNativeChatMultiSelectQuestion(question: unknown): boolean {
  if (!question || typeof question !== 'object') {
    return false
  }
  const value = question as { multiSelect?: unknown; multi_select?: unknown }
  return value.multiSelect === true || value.multi_select === true
}
