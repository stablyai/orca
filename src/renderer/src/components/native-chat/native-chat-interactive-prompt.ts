// Pure parser for the live `agentStatus.interactivePrompt` envelope (JSON the
// host captures from the agent's hook). It resolves to either a structured
// question prompt (AskUserQuestion) or a tool-approval (PermissionRequest), the
// two interactive cards the native chat renders just above the composer. Kept
// pure (no React/IO) so the envelope rules are unit-testable.
//
// Why: the Ask question parser (parseQuestionsShape/parseOptions/the
// QUESTION_TOOL_PARSERS registry/parseToolInput/formatAskAnswer) is a byte-for-byte
// mirror of mobile's `mobile-native-chat-ask.ts` — Metro can't import these runtime
// values from src/shared, so both copies must stay in sync; parity is asserted by
// `src/shared/native-chat-ask-parser-parity.test.ts`. The approval-card logic below
// (ChatApproval/parseApprovalFromStatus/ESCAPE) is desktop-only.

import type {
  AskOption,
  AskPrompt,
  AskQuestion,
  InteractiveQuestionParser
} from '../../../../shared/native-chat-ask-types'
import { translate } from '@/i18n/i18n'

export type { AskOption, AskPrompt, AskQuestion, InteractiveQuestionParser }

/** A detected tool-approval, rendered as an Allow/Deny card. Each option's
 *  `send` is the literal string written back to the agent's PTY when chosen
 *  (a number to allow; the ESC char to deny). */
export type ChatApproval = {
  title: string
  detail?: string
  options: { label: string; send: string }[]
}

/** The interactive card to render for the current live status, or null. A
 *  question takes precedence over an approval when both somehow parse. */
export type InteractivePromptCard =
  | { kind: 'question'; prompt: AskPrompt }
  | { kind: 'approval'; approval: ChatApproval }
  | null

// ESC interrupts the agent over the PTY (matches how the composer forwards
// Escape), so "Cancel"/"Deny" sends this byte.
const ESCAPE = String.fromCharCode(27)

// Registry of question-tool parsers keyed by the tool name the agent reports.
// To support a new terminal/agent's question tool, register its parser here (or
// via registerQuestionTool) — the renderer and wiring stay unchanged.
const QUESTION_TOOL_PARSERS = new Map<string, InteractiveQuestionParser>()

export function registerQuestionTool(toolName: string, parser: InteractiveQuestionParser): void {
  QUESTION_TOOL_PARSERS.set(toolName, parser)
}

/** Claude's AskUserQuestion shape: `{ questions: [{ question, header,
 *  multiSelect, options: [{ label, description }] }] }`. Also the de-facto
 *  default shape, so a new agent that reuses it works without registration. */
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
    const q = raw as Record<string, unknown>
    const question = typeof q.question === 'string' ? q.question : ''
    const options = parseOptions(q.options)
    if (question || options.length > 0) {
      questions.push({
        question,
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect === true,
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
    .map((o): AskOption | null => {
      if (typeof o === 'string') {
        return { label: o }
      }
      if (o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string') {
        const obj = o as { label: string; description?: unknown }
        return {
          label: obj.label,
          description: typeof obj.description === 'string' ? obj.description : undefined
        }
      }
      return null
    })
    .filter((o): o is AskOption => o !== null)
}

// Claude's AskUserQuestion (and aliases) ship the canonical questions shape.
for (const name of ['AskUserQuestion', 'ask_user_question', 'askUserQuestion']) {
  QUESTION_TOOL_PARSERS.set(name, parseQuestionsShape)
}

/** Resolve an interactive-prompt payload to an AskPrompt: try the tool's
 *  registered parser first, then fall back to the canonical questions shape so a
 *  new agent that happens to use the same structure works without registration. */
function parseToolInput(toolName: string | undefined, input: unknown): AskPrompt | null {
  const parser = toolName ? QUESTION_TOOL_PARSERS.get(toolName) : undefined
  return (parser ? parser(input) : null) ?? parseQuestionsShape(input)
}

/** Parse the live `agentStatus.interactivePrompt` (the agent's untruncated
 *  question-tool input as JSON) into an AskPrompt, or null. Dispatches through
 *  the tool's registered parser (keyed by `toolName`) with the canonical
 *  questions shape as the fallback. */
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

/** Parse the `{ approval: { tool, summary } }` envelope (emitted by the host on
 *  a PermissionRequest) into an Allow/Deny card, or null. Allow sends "1"; Deny
 *  sends ESC — matching the common TUI approval prompt. */
export function parseApprovalFromStatus(
  interactivePrompt: string | undefined | null
): ChatApproval | null {
  if (!interactivePrompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const approval = (parsed as { approval?: unknown }).approval
  if (!approval || typeof approval !== 'object') {
    return null
  }
  const tool = (approval as { tool?: unknown }).tool
  if (typeof tool !== 'string' || tool.length === 0) {
    return null
  }
  const summary = (approval as { summary?: unknown }).summary
  return {
    title: translate('components.native-chat.approval.title', 'Allow {{value0}}?', {
      value0: tool
    }),
    detail: typeof summary === 'string' && summary.length > 0 ? summary : undefined,
    options: [
      { label: translate('components.native-chat.approval.allow', 'Allow'), send: '1' },
      { label: translate('components.native-chat.approval.deny', 'Deny'), send: ESCAPE }
    ]
  }
}

/** Resolve the live `interactivePrompt` to the single card to render. A question
 *  takes precedence over an approval. `toolName` is forwarded to the Ask branch
 *  for registry dispatch; the approval branch ignores it. */
export function parseInteractivePrompt(
  interactivePrompt: string | undefined | null,
  toolName?: string
): InteractivePromptCard {
  const prompt = parseAskFromStatus(interactivePrompt, toolName)
  if (prompt) {
    return { kind: 'question', prompt }
  }
  const approval = parseApprovalFromStatus(interactivePrompt)
  if (approval) {
    return { kind: 'approval', approval }
  }
  return null
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
// against Claude Code's TUI; groups are written spaced apart (see the desktop
// sender) because a navigation keystroke batched with Enter commits before the
// selector has applied it.
const ASK_ENTER = '\r'
const ASK_NEXT_TAB = '\x1b[C'

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

/** Whether any question in `selections` carries an answer worth submitting. */
export function hasAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): boolean {
  return prompt.questions.some((_, i) => isAnswered(selections[i]))
}
