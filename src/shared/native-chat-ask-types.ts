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

export type InteractiveQuestionParser = (input: unknown) => AskPrompt | null
