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

/** Build the answer text to send: exactly one line per question, in question
 *  order, each line the selected option label(s) joined by ", ". Empty answers
 *  stay as empty lines (not dropped) so N lines always == N questions — the
 *  per-question Enter stepping counts one Enter per line, so dropping a blank
 *  middle answer would misalign the count and leave the prompt unsubmitted. */
export function formatAskAnswer(prompt: AskPrompt, selections: string[][]): string {
  return prompt.questions.map((_, i) => (selections[i] ?? []).join(', ')).join('\n')
}
