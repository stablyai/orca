/* eslint-disable no-control-regex -- Why: terminal quota detection must strip ANSI and control bytes before matching provider output. */
import type { ResumableTuiAgent } from './agent-session-resume'

export type AutoSwitchRateLimitAgent = Extract<ResumableTuiAgent, 'claude' | 'codex'>

export type AgentRateLimitDetectionState = {
  tail: string
}

const DETECTION_TAIL_LIMIT = 4000

const ANSI_SEQUENCE_RE =
  /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][\s\S]*?\x1b\\|[@-_])/g
const CONTROL_CHARACTER_RE = /[\x00-\x08\x0b-\x1f\x7f]/g

const NON_ACCOUNT_LIMIT_PATTERNS = [
  /\bcontext\s+(?:length|limit|window)\b/i,
  /\b(?:maximum|max)\s+(?:context|token|tokens)\b/i,
  /\btoken\s+limit\b/i,
  /\boutput\s+limit\b/i,
  /\bconversation\s+(?:is\s+)?too\s+long\b/i,
  /\binput\s+too\s+long\b/i
] as const

const ACCOUNT_LIMIT_PATTERNS = [
  /\brate\s+limited\b/i,
  /\b(?:rate|usage|quota)\s+(?:limit\s+)?(?:exceeded|reached|hit)\b/i,
  /\b(?:limit|quota)\s+(?:exceeded|reached|hit)\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\b(?:http|status|error)\s*429\b/i,
  /\b(?:you(?:'ve|\s+have)|we(?:'ve|\s+have))\s+(?:reached|hit)\s+(?:your|the)?[\s\S]{0,80}\b(?:rate|usage|quota)\s+limit\b/i,
  /\b(?:daily|weekly|monthly|5-hour|five-hour)\s+(?:limit|quota)\s+(?:exceeded|reached|hit)\b/i
] as const

const AUTO_SWITCH_RATE_LIMIT_AGENTS = new Set<string>(['claude', 'codex'])

/** Narrows live terminal agent ids to providers Orca can both resume and account-switch. */
export function isAutoSwitchRateLimitAgent(value: unknown): value is AutoSwitchRateLimitAgent {
  return typeof value === 'string' && AUTO_SWITCH_RATE_LIMIT_AGENTS.has(value)
}

/** Removes terminal control bytes so quota patterns can match rendered provider text. */
function normalizeTerminalOutput(value: string): string {
  return value
    .replace(ANSI_SEQUENCE_RE, ' ')
    .replace(CONTROL_CHARACTER_RE, ' ')
    .replace(/\s+/g, ' ')
}

/** Keeps enough previous output to detect rate-limit phrases split across PTY chunks. */
function rememberTail(state: AgentRateLimitDetectionState, value: string): string {
  const next = `${state.tail}${value}`
  state.tail = next.length > DETECTION_TAIL_LIMIT ? next.slice(-DETECTION_TAIL_LIMIT) : next
  return state.tail
}

/** Detects provider account-limit output while filtering context/token-limit messages. */
export function detectAgentRateLimitOutput(
  agent: AutoSwitchRateLimitAgent,
  chunk: string,
  state: AgentRateLimitDetectionState
): boolean {
  if (!isAutoSwitchRateLimitAgent(agent) || chunk.length === 0) {
    return false
  }

  const normalized = normalizeTerminalOutput(rememberTail(state, chunk))
  if (NON_ACCOUNT_LIMIT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false
  }

  return ACCOUNT_LIMIT_PATTERNS.some((pattern) => pattern.test(normalized))
}
