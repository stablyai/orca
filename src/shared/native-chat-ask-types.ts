// Canonical AskUserQuestion prompt types consumed by the shared parser and both
// native-chat platform UIs.

export type AskOption = { label: string; description?: string }
export type AskQuestion = {
  question: string
  header?: string
  multiSelect: boolean
  options: AskOption[]
}
export type AskPrompt = {
  questions: AskQuestion[]
  /** The agent kept working after asking, so the answer goes back as an ordinary message. */
  replyAsMessage?: true
}

/** A parser turns one agent's interactive-question tool input into the normalized
 *  AskPrompt the card renders. */
export type InteractiveQuestionParser = (input: unknown) => AskPrompt | null
