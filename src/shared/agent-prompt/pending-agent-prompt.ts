import { isAgentSessionId } from '../agent-session/lifecycle/agent-session-record'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../agent-session/journal/agent-session-journal-types'
import type { AgentPromptOptionRole, PendingAgentPrompt } from '../rpc-contract/agent-prompt-params'
import type { PendingPrompt } from '../agent-status/contracts/agent-pending-prompt'

const DETAIL_MAX = 300
const TERMINAL_FINGERPRINT = /^[0-9a-f]{20}$/
const APPROVE_IDS = new Set(['allow', 'allow_once', 'accept', 'approve', 'yes'])
const DENY_IDS = new Set(['deny', 'reject', 'reject_once', 'decline', 'no', 'cancel'])
const ALWAYS_IDS = new Set([
  'allowForSession',
  'allow_always',
  'acceptForSession',
  'allow-always',
  'always'
])

export type ChatPromptSourceItem = Pick<
  AgentJournalRenderItem,
  'itemId' | 'revision' | 'observedAt' | 'body'
>

/** Collapse whitespace and keep the watch detail inside its 300-character contract. */
export function clipAgentPromptDetail(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return undefined
  }
  return normalized.length <= DETAIL_MAX ? normalized : `${normalized.slice(0, DETAIL_MAX - 1)}…`
}

export function agentPromptOptionRole(optionId: string, label: string): AgentPromptOptionRole {
  if (ALWAYS_IDS.has(optionId) || /always/i.test(label)) {
    return 'approve-always'
  }
  if (APPROVE_IDS.has(optionId)) {
    return 'approve'
  }
  if (DENY_IDS.has(optionId)) {
    return 'deny'
  }
  return 'other'
}

export function chatPromptId(sessionId: string, itemId: string, revision: number): string {
  return `chat:${sessionId}:${itemId}:${revision}`
}

export function parseChatPromptId(
  promptId: string
): { sessionId: string; itemId: string; revision: number } | null {
  if (!promptId.startsWith('chat:')) {
    return null
  }
  const body = promptId.slice('chat:'.length)
  const revisionAt = body.lastIndexOf(':')
  if (revisionAt <= 0) {
    return null
  }
  const revisionText = body.slice(revisionAt + 1)
  if (!/^[0-9]+$/.test(revisionText)) {
    return null
  }
  const revision = Number(revisionText)
  if (!Number.isSafeInteger(revision)) {
    return null
  }
  const head = body.slice(0, revisionAt)
  const sessionAt = head.indexOf(':')
  if (sessionAt <= 0) {
    return null
  }
  const sessionId = head.slice(0, sessionAt)
  const itemId = head.slice(sessionAt + 1)
  if (!itemId || !isAgentSessionId(sessionId)) {
    return null
  }
  return { sessionId, itemId, revision }
}

export function terminalPromptId(ptyId: string, fingerprint: string): string {
  return `term:${ptyId}:${fingerprint}`
}

/** The answerer's internal id is `p_` plus the same 20-hex fingerprint the contract publishes. */
export function terminalInternalPromptId(fingerprint: string): string {
  return `p_${fingerprint}`
}

export function parseTerminalPromptId(
  promptId: string
): { ptyId: string; fingerprint: string } | null {
  if (!promptId.startsWith('term:')) {
    return null
  }
  const body = promptId.slice('term:'.length)
  const splitAt = body.lastIndexOf(':')
  if (splitAt <= 0) {
    return null
  }
  const ptyId = body.slice(0, splitAt)
  const fingerprint = body.slice(splitAt + 1)
  if (!ptyId || !TERMINAL_FINGERPRINT.test(fingerprint)) {
    return null
  }
  return { ptyId, fingerprint }
}

export function parseAgentPromptId(promptId: string): boolean {
  return parseChatPromptId(promptId) !== null || parseTerminalPromptId(promptId) !== null
}

function promptOptions(
  options: readonly { id: string; label: string }[]
): PendingAgentPrompt['options'] | null {
  const mapped = options.flatMap((option) => {
    const optionId = option.id.trim()
    const label = option.label.trim()
    if (!optionId || !label) {
      return []
    }
    return [{ optionId, label, role: agentPromptOptionRole(optionId, label) }]
  })
  return mapped.length === options.length && mapped.length > 0 ? mapped : null
}

function questionIsOneChoice(body: Pick<AgentJournalQuestionItem, 'questions'>): boolean {
  const questions = body.questions
  if (!questions || questions.length === 0) {
    return true
  }
  return questions.length === 1 && questions[0]?.multiSelect === false
}

export function mapChatPrompt(input: {
  sessionId: string
  worktreeId: string
  agent: string
  item: ChatPromptSourceItem
}): PendingAgentPrompt | null {
  const { body } = input.item
  if (body.kind !== 'approval' && body.kind !== 'question') {
    return null
  }
  if (!input.worktreeId || !input.agent) {
    return null
  }
  if (body.kind === 'question' && !questionIsOneChoice(body)) {
    return null
  }
  const options = promptOptions(body.options)
  const title = (body.kind === 'approval' ? body.title : body.question).trim()
  if (!options || !title) {
    return null
  }
  const detail = body.kind === 'approval' ? approvalDetail(body) : undefined
  return {
    promptId: chatPromptId(input.sessionId, input.item.itemId, input.item.revision),
    kind: body.kind === 'approval' ? 'permission' : 'question',
    target: { type: 'chat', sessionId: input.sessionId },
    worktreeId: input.worktreeId,
    agent: input.agent,
    title,
    ...(detail ? { detail } : {}),
    options,
    createdAt: input.item.observedAt
  }
}

function approvalDetail(
  body: Pick<AgentJournalApprovalItem, 'displayName' | 'detail'>
): string | undefined {
  const tool = body.displayName?.trim()
  const summary = body.detail?.trim()
  if (tool && summary) {
    return clipAgentPromptDetail(`${tool}: ${summary}`)
  }
  return clipAgentPromptDetail(tool || summary || '')
}

export function mapTerminalPrompt(input: {
  ptyId: string
  handle: string
  worktreeId: string
  agent: string
  createdAt: number
  prompt: PendingPrompt
}): PendingAgentPrompt | null {
  if (input.prompt.kind === 'unsupported') {
    return null
  }
  if (!input.ptyId || !input.handle || !input.worktreeId || !input.agent) {
    return null
  }
  if (!input.prompt.promptId.startsWith('p_')) {
    return null
  }
  const fingerprint = input.prompt.promptId.slice(2)
  if (!TERMINAL_FINGERPRINT.test(fingerprint)) {
    return null
  }
  const options = promptOptions(input.prompt.options)
  if (!options) {
    return null
  }
  if (input.prompt.kind === 'approval') {
    const title = input.prompt.tool.trim()
    if (!title) {
      return null
    }
    const summary = input.prompt.summary?.trim()
    const detail = clipAgentPromptDetail(summary ? `${title}: ${summary}` : title)
    return {
      promptId: terminalPromptId(input.ptyId, fingerprint),
      kind: 'permission',
      target: { type: 'terminal', terminal: input.handle },
      worktreeId: input.worktreeId,
      agent: input.agent,
      title,
      ...(detail ? { detail } : {}),
      options,
      createdAt: input.createdAt
    }
  }
  const title = input.prompt.question.trim()
  if (!title) {
    return null
  }
  const detail = input.prompt.header ? clipAgentPromptDetail(input.prompt.header) : undefined
  return {
    promptId: terminalPromptId(input.ptyId, fingerprint),
    kind: 'question',
    target: { type: 'terminal', terminal: input.handle },
    worktreeId: input.worktreeId,
    agent: input.agent,
    title,
    ...(detail ? { detail } : {}),
    options,
    createdAt: input.createdAt
  }
}
