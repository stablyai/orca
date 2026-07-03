// Canonical AskUserQuestion prompt types shared by both native-chat surfaces
// (desktop `native-chat-interactive-prompt.ts` and mobile `mobile-native-chat-ask.ts`).
// Types only — both surfaces `import type` from here (Metro can't resolve runtime
// values from src/shared), so the type declarations stop being duplicated while
// the parser bodies stay mirrored and parity-tested.

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
