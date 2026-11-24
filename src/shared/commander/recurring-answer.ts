export const recurringAnswerTitle = 'Recurring answer'
export const recurringQuestionLimit = 500
export const recurringAnswerLimit = 2000

type RecurringAnswer = { question: string; answer: string }
type RulePage = { kind: string; title: string; body: string }

function validText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value
  )
}

export function formatRecurringAnswer(question: string, answer: string): string {
  if (!validText(question, recurringQuestionLimit) || !validText(answer, recurringAnswerLimit)) {
    throw new Error('Invalid recurring question or answer.')
  }
  return JSON.stringify({ version: 1, question, answer }, null, 2)
}

export function readRecurringAnswer(page: RulePage): RecurringAnswer | null {
  if (page.kind !== 'guideline' || page.title !== recurringAnswerTitle) {
    return null
  }
  try {
    const value = JSON.parse(page.body)
    if (
      value?.version === 1 &&
      Object.keys(value).length === 3 &&
      validText(value.question, recurringQuestionLimit) &&
      validText(value.answer, recurringAnswerLimit)
    ) {
      return { question: value.question, answer: value.answer }
    }
  } catch {
    // Older Memory clients can save arbitrary Markdown in a guideline.
  }
  return null
}

export function humanRecurringAnswer(
  page: RulePage & {
    projectId?: string | null
    actor: { type: string }
    createdBy: { type: string }
  }
): RecurringAnswer | null {
  return page.projectId && page.actor.type === 'human' && page.createdBy.type === 'human'
    ? readRecurringAnswer(page)
    : null
}
