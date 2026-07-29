import type {
  AskOption,
  AskPrompt,
  AskQuestion,
  InteractiveQuestionParser
} from './native-chat-ask-types'
import type { NativeChatMessage } from './native-chat-types'

export type { AskOption, AskPrompt, AskQuestion, InteractiveQuestionParser }

const QUESTION_TOOL_PARSERS = new Map<string, InteractiveQuestionParser>()

export function registerQuestionTool(toolName: string, parser: InteractiveQuestionParser): void {
  QUESTION_TOOL_PARSERS.set(toolName, parser)
}

function parseQuestionsShape(input: unknown): AskPrompt | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const rawQuestions = (input as { questions?: unknown }).questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return null
  }
  const questions: AskQuestion[] = []
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const question = raw as Record<string, unknown>
    const text = typeof question.question === 'string' ? question.question : ''
    const options = parseOptions(question.options)
    if (text || options.length > 0) {
      questions.push({
        question: text,
        header: typeof question.header === 'string' ? question.header : undefined,
        multiSelect: question.multiSelect === true,
        options
      })
    }
  }
  return questions.length > 0 ? { questions } : null
}

function parseOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((option): AskOption | null => {
      if (typeof option === 'string') {
        return { label: option }
      }
      if (
        option &&
        typeof option === 'object' &&
        typeof (option as { label?: unknown }).label === 'string'
      ) {
        const value = option as { label: string; description?: unknown }
        return {
          label: value.label,
          description: typeof value.description === 'string' ? value.description : undefined
        }
      }
      return null
    })
    .filter((option): option is AskOption => option !== null)
}

for (const name of ['AskUserQuestion', 'ask_user_question', 'askUserQuestion']) {
  QUESTION_TOOL_PARSERS.set(name, parseQuestionsShape)
}

function parseToolInput(toolName: string | undefined, input: unknown): AskPrompt | null {
  const parser = toolName ? QUESTION_TOOL_PARSERS.get(toolName) : undefined
  return (parser ? parser(input) : null) ?? parseQuestionsShape(input)
}

export function parseAskFromStatus(
  interactivePrompt: string | undefined | null,
  toolName?: string
): AskPrompt | null {
  if (!interactivePrompt) {
    return null
  }
  try {
    return parseToolInput(toolName, JSON.parse(interactivePrompt))
  } catch {
    return null
  }
}

/** Resolve the newest question tool that has not received its FIFO tool result.
 *  Transcript replay parses each tool-call through the same registered-parser +
 *  canonical-shape fallback as live status, so a question tool that rendered
 *  live cannot vanish from pending state after a reconnect/replay. */
export function extractPendingAsk(messages: readonly NativeChatMessage[]): AskPrompt | null {
  let pending: AskPrompt | null = null
  const outstanding: (AskPrompt | null)[] = []
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool-call') {
        const parsed = parseToolInput(block.name, block.input)
        if (parsed) {
          pending = parsed
        }
        outstanding.push(parsed)
      } else if (block.type === 'tool-result' && outstanding.length > 0) {
        const resolved = outstanding.shift()
        if (resolved && resolved === pending) {
          pending = null
        }
      }
    }
  }
  return pending
}

/** One question's chosen answer, normalized for delivery: the selected option
 *  indices (in option order) plus any free-text "other" answer. Index-based (not
 *  label text) so the answer can be delivered by the selector's stable option
 *  number — see `buildAskAnswerKeys`. */
export type AskAnswerSelection = { indices: number[]; other?: string }

/** A single keystroke group to write to the agent PTY. `raw` bytes (option
 *  numbers, Enter, arrows) are written verbatim as keystrokes; `text` is a
 *  free-text answer the caller runs through its paste sanitizer before writing. */
export type AskAnswerKeyGroup = { raw: string } | { text: string }

/** True when this question is answered (a picked option or typed free text). */
function isAnswered(sel: AskAnswerSelection | undefined): boolean {
  return (sel?.indices.length ?? 0) > 0 || (sel?.other ?? '').trim().length > 0
}

/** The picked labels + trimmed free text for one question, in option order. */
function answerLabels(question: AskQuestion, sel: AskAnswerSelection | undefined): string[] {
  const labels = (sel?.indices ?? [])
    .map((i) => question.options[i]?.label ?? '')
    .filter((l) => l.length > 0)
  const other = (sel?.other ?? '').trim()
  return other ? [...labels, other] : labels
}

/** Build the human-readable answer text: one line per question, in question
 *  order, each the selected label(s) + free text joined by ", ". Empty answers
 *  stay empty lines so N lines always == N questions. Used for agents whose
 *  question tool commits a pasted answer (not Claude's arrow-navigate selector). */
export function formatAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): string {
  return prompt.questions.map((q, i) => answerLabels(q, selections[i]).join(', ')).join('\n')
}

// Claude's AskUserQuestion is an arrow-navigate selector: a bare Enter commits
// the HIGHLIGHTED default (the first option), and pasted label text does not move
// the highlight — so answering by label silently delivered every non-first pick
// as the first option (STA-1860). Instead we drive the selector by each option's
// stable 1-based number (which matches the card's badge), the marker it commits
// on. Right-arrow steps to the next question / the Submit tab. Verified live
// against Claude Code's TUI; groups are written spaced apart (see the senders)
// because a navigation keystroke batched with Enter commits before the selector
// has applied it.
const ASK_ENTER = '\r'
const ASK_NEXT_TAB = '\x1b[C'
const ASK_PREVIOUS_ROW = '\x1b[A'
const ASK_NEXT_ROW = '\x1b[B'
const ASK_NOTES = '\t'

/** Build the ordered keystroke groups that answer a Claude Code AskUserQuestion.
 *  Each group is written a step apart so the selector applies it before the next.
 *
 *  - single-select pick  → the option number (selects AND commits; in a
 *    multi-question prompt it auto-advances to the next question)
 *  - free-text answer    → the "Type something" row number, the text, then Enter
 *  - multi-select        → each option number TOGGLES its checkbox, then a step
 *    to the Submit tab
 *  - a multi-question prompt (and a lone multi-select) finishes on a Submit
 *    confirmation, so it ends with one Enter
 *
 *  (Option counts are ≤ the tool's cap of a few, so single-digit numbers always
 *  address every row.) */
export function buildAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const questions = prompt.questions
  const multiQuestion = questions.length > 1
  const groups: AskAnswerKeyGroup[] = []

  questions.forEach((q, qi) => {
    const sel = selections[qi]
    const other = (sel?.other ?? '').trim()
    const typeSomething = String(q.options.length + 1)

    if (q.multiSelect) {
      for (const i of sel?.indices ?? []) {
        groups.push({ raw: String(i + 1) })
      }
      if (other) {
        groups.push({ raw: typeSomething }, { text: other }, { raw: ASK_ENTER })
      }
      // A multi-select never auto-advances; step to the next tab (the Submit tab
      // when this is the last question).
      groups.push({ raw: ASK_NEXT_TAB })
    } else if (other) {
      // Single-select can only carry one value, so route any answer that
      // includes free text through the "Type something" row as one string.
      groups.push(
        { raw: typeSomething },
        { text: answerLabels(q, sel).join(', ') },
        { raw: ASK_ENTER }
      )
    } else if ((sel?.indices.length ?? 0) > 0) {
      groups.push({ raw: String(sel!.indices[0]! + 1) })
    } else if (multiQuestion) {
      // Unanswered question in a multi-question prompt: step past it.
      groups.push({ raw: ASK_NEXT_TAB })
    }
  })

  const endsOnSubmitTab =
    multiQuestion || (questions.length === 1 && questions[0]!.multiSelect === true)
  if (endsOnSubmitTab && groups.length > 0) {
    groups.push({ raw: ASK_ENTER })
  }
  return groups
}

/** Build keystrokes for Codex's request_user_input overlay.
 *
 * Unlike Claude, Codex submits on the final option digit and attaches free text
 * as notes to the highlighted row. The overlay starts on the first row, so note
 * answers move to the target without committing, open notes with Tab, then
 * submit with Enter. */
export function buildCodexAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const groups: AskAnswerKeyGroup[] = []
  let hasUnanswered = false

  prompt.questions.forEach((question, questionIndex) => {
    const selection = selections[questionIndex]
    const selectedIndex = selection?.indices[0]
    const note = (selection?.other ?? '').trim()

    if (note) {
      const targetIndex = selectedIndex ?? question.options.length
      const rowCount = question.options.length + 1
      const nextSteps = targetIndex
      const previousSteps = rowCount - targetIndex
      const usePrevious = previousSteps < nextSteps
      const navigationKey = usePrevious ? ASK_PREVIOUS_ROW : ASK_NEXT_ROW
      const navigationSteps = usePrevious ? previousSteps : nextSteps
      for (let index = 0; index < navigationSteps; index += 1) {
        groups.push({ raw: navigationKey })
      }
      groups.push({ raw: ASK_NOTES }, { text: note }, { raw: ASK_ENTER })
      return
    }

    if (selectedIndex !== undefined) {
      groups.push({ raw: String(selectedIndex + 1) })
      return
    }

    hasUnanswered = true
    groups.push({ raw: '\x7f' })
    if (questionIndex < prompt.questions.length - 1) {
      groups.push({ raw: ASK_NEXT_TAB })
    } else {
      groups.push({ raw: ASK_ENTER })
    }
  })

  // Codex opens a confirmation after the last question when any were skipped;
  // Proceed is highlighted by default, so one Enter submits the partial answer.
  if (hasUnanswered) {
    groups.push({ raw: ASK_ENTER })
  }
  return groups
}

/** Whether any question in `selections` carries an answer worth submitting. */
export function hasAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): boolean {
  return prompt.questions.some((_, i) => isAnswered(selections[i]))
}
