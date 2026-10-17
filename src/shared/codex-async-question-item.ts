export type CodexAsyncQuestion = { title: string; options?: string[] }

/** Reject oversized cards rather than silently changing their answer choices. */
export function readCodexAsyncQuestionList(value: unknown): CodexAsyncQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  const questions: CodexAsyncQuestion[] = []
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.title !== 'string' ||
      !entry.title.trim()
    ) {
      return null
    }
    const options = Array.isArray(entry.options)
      ? entry.options.filter((option: unknown): option is string => typeof option === 'string')
      : []
    questions.push({ title: entry.title, options })
  }
  return new TextEncoder().encode(JSON.stringify(questions)).length <= 16 * 1024 ? questions : null
}

/** Reads the arguments of a recorded async tool call. */
export function readCodexAsyncQuestionCallArguments(input: unknown): CodexAsyncQuestion[] | null {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && 'questions' in value
    ? readCodexAsyncQuestionList(value.questions)
    : null
}

export function codexAsyncQuestionListsEqual(
  a: readonly CodexAsyncQuestion[],
  b: readonly CodexAsyncQuestion[]
): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
