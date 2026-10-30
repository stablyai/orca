export type AskOption = { label: string; description?: string }
export type AskQuestion = {
  question: string
  header?: string
  multiSelect: boolean
  options: AskOption[]
  /** Claude renders its preview selector: digits only move focus, Enter commits, free text is a note. */
  hasPreviews?: true
}
export type AskPrompt = {
  questions: AskQuestion[]
  /** The agent kept working after asking, so the answer goes back as an ordinary message. */
  replyAsMessage?: true
  /** The individually addressed calls displayed by this local projection. */
  occurrenceIds?: readonly string[]
}

export type InteractiveQuestionParser = (input: unknown) => AskPrompt | null
