// Canonical AskUserQuestion prompt types consumed by the shared parser and both
// native-chat platform UIs.

export type AskOption = { label: string; description?: string }
export type AskQuestion = {
  question: string
  header?: string
  multiSelect: boolean
  options: AskOption[]
}
export type AskPrompt = { questions: AskQuestion[] }

/** A parser turns one agent's interactive-question tool input into the normalized
 *  AskPrompt the card renders. */
export type InteractiveQuestionParser = (input: unknown) => AskPrompt | null

/** One question's chosen answer, normalized for delivery: the selected option
 *  indices (in option order) plus any free-text "other" answer. Index-based (not
 *  label text) because every stepped selector commits a row, not typed text. */
export type AskAnswerSelection = { indices: number[]; other?: string }

/** A single keystroke group to write to the agent PTY. `raw` bytes (option
 *  numbers, Enter, arrows) are written verbatim as keystrokes; `text` is a
 *  free-text answer the caller runs through its paste sanitizer before writing. */
export type AskAnswerKeyGroup = { raw: string } | { text: string }
