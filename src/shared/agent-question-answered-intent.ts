import type { AgentType } from './agent-status-types'

/** Baseline snapshot the renderer captured when it observed the submit
 *  keystroke. The main process re-validates every field against its own
 *  cached status so a racing real hook always wins over the inference. */
export type AgentQuestionAnsweredInferenceRequest = {
  paneKey: string
  baselineUpdatedAt: number
  baselineStateStartedAt: number
  baselinePrompt: string
  baselineAgentType: AgentType | undefined
}

/** True for the ask-the-user-a-question tool across agents: Claude's
 *  `AskUserQuestion`, grok/Pi's `ask_user_question`, and Codex ≥0.145's
 *  `request_user_input` (same questions/options input shape).
 *  Why: this is the structured "pick an option" prompt whose full input the
 *  clients render as a live card. */
export function isAskUserQuestionTool(toolName: string | undefined): boolean {
  const normalized = toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'askuserquestion' || normalized === 'requestuserinput'
}

const QUESTION_ANSWER_ENTER_INPUTS: ReadonlySet<string> = new Set([
  '\r',
  '\n',
  '\r\n',
  '\x1b[13u',
  '\x1b[13;1u'
])
const QUESTION_ANSWER_DIGIT_INPUTS: ReadonlySet<string> = new Set('123456789')

export function isPotentialQuestionAnsweredSubmitInput(data: string): boolean {
  return QUESTION_ANSWER_ENTER_INPUTS.has(data) || QUESTION_ANSWER_DIGIT_INPUTS.has(data)
}

function readSingleSelectOptionCount(interactivePrompt: string | undefined): number | null {
  if (!interactivePrompt) {
    return null
  }
  try {
    const parsed = JSON.parse(interactivePrompt) as { questions?: unknown }
    if (!Array.isArray(parsed.questions) || parsed.questions.length !== 1) {
      return -1
    }
    const [question] = parsed.questions as { multiSelect?: unknown; options?: unknown }[]
    if (!question || question.multiSelect === true || !Array.isArray(question.options)) {
      return -1
    }
    return question.options.length
  } catch {
    // Why: malformed JSON can be a length-capped multi-question payload. It is
    // not equivalent to an older hook omitting tool input, so fail closed.
    return -1
  }
}

/** True only when one keystroke is enough to finish the whole prompt.
 *  Why: digits merely advance multi-question prompts and toggle multi-selects;
 *  the synthetic "Type something" row also opens an editor instead of
 *  submitting. Without the prompt-shape gate those partial choices clear the
 *  waiting indicator while Claude is still blocked on more input. */
export function isQuestionAnsweredSubmitInput(
  data: string,
  interactivePrompt: string | undefined
): boolean {
  if (!isPotentialQuestionAnsweredSubmitInput(data)) {
    return false
  }
  const optionCount = readSingleSelectOptionCount(interactivePrompt)
  if (optionCount === -1) {
    return false
  }
  if (QUESTION_ANSWER_ENTER_INPUTS.has(data)) {
    // Older hook payloads can omit tool input; Enter remains the conservative
    // fallback because it is the ordinary submit path for a question.
    return true
  }
  if (optionCount === null) {
    return false
  }
  // Claude adds a final "Type something" row after the declared options.
  // Only declared option numbers complete a single-select immediately.
  return Number(data) <= optionCount
}
