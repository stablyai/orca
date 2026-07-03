import type { AgentHookSource } from './agent-hook-relay'
import type { AgentStatusState } from './agent-status-types'
import type { TuiAgent } from './types'

export const RESUMABLE_TUI_AGENTS = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
  'mimo-code',
  'droid',
  'grok',
  'devin'
] as const satisfies readonly TuiAgent[]

export type ResumableTuiAgent = (typeof RESUMABLE_TUI_AGENTS)[number]

export type AgentProviderSessionKey = 'session_id' | 'conversation_id'

export type AgentProviderSessionMetadata = {
  key: AgentProviderSessionKey
  id: string
  /** Authoritative on-disk transcript/rollout path reported by the agent's hook
   *  (Claude/Codex `transcript_path`), when available. Native chat reads this
   *  directly because recent Claude Code versions name the transcript file with a
   *  UUID that differs from the hook `session_id`, so reconstructing the path from
   *  `id` alone fails. `id` is still used for CLI resume (`--resume <id>`). */
  transcriptPath?: string
}

export type SleepingAgentLaunchConfig = {
  agentCommand?: string
  agentArgs: string
  agentEnv: Record<string, string>
}

export type SleepingAgentSessionRecord = {
  paneKey: string
  tabId?: string
  worktreeId: string
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  prompt: string
  state: AgentStatusState
  capturedAt: number
  updatedAt: number
  terminalTitle?: string
  lastAssistantMessage?: string
  interrupted?: boolean
  connectionId?: string | null
  launchConfig?: SleepingAgentLaunchConfig
  /** How the record was captured. Worktree-sleep records (legacy records have
   *  no origin) are consumed by worktree activation, which opens a fresh tab.
   *  Quit/live records describe panes that still exist in the restored session,
   *  so only the pane's own cold-restore path may consume them — activation
   *  launching a tab too would duplicate a warm-reattached session (#5232). */
  origin?: 'worktree-sleep' | 'quit' | 'live'
}

const RESUMABLE_TUI_AGENT_SET: ReadonlySet<string> = new Set(RESUMABLE_TUI_AGENTS)
const PROVIDER_SESSION_ID_MAX_LENGTH = 512

export function hasUnsafeProviderSessionIdChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > PROVIDER_SESSION_ID_MAX_LENGTH ||
    trimmed.startsWith('-') ||
    hasUnsafeProviderSessionIdChars(trimmed)
  ) {
    return null
  }
  return trimmed
}

function readSessionId(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const normalized = normalizeSessionId(record[key])
    if (normalized) {
      return normalized
    }
  }
  return null
}

/** The agent hook's authoritative transcript/rollout path, when present. Used by
 *  native chat to read the exact file rather than reconstructing it from the
 *  session id (which recent Claude Code no longer matches to the file name). */
function readTranscriptPath(record: Record<string, unknown>): string | undefined {
  const raw = record.transcript_path ?? record.transcriptPath
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  if (!trimmed || hasUnsafeProviderSessionIdChars(trimmed)) {
    return undefined
  }
  return trimmed
}

function withTranscriptPath(
  metadata: AgentProviderSessionMetadata,
  payload: Record<string, unknown>
): AgentProviderSessionMetadata {
  const transcriptPath = readTranscriptPath(payload)
  return transcriptPath ? { ...metadata, transcriptPath } : metadata
}

export function isResumableTuiAgent(value: unknown): value is ResumableTuiAgent {
  return typeof value === 'string' && RESUMABLE_TUI_AGENT_SET.has(value)
}

export function normalizeAgentProviderSession(raw: unknown): AgentProviderSessionMetadata | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Record<string, unknown>
  const key = record.key
  if (key !== 'session_id' && key !== 'conversation_id') {
    return null
  }
  const id = normalizeSessionId(record.id)
  if (!id) {
    return null
  }
  const transcriptPath =
    typeof record.transcriptPath === 'string' && record.transcriptPath.trim().length > 0
      ? record.transcriptPath
      : undefined
  return transcriptPath ? { key, id, transcriptPath } : { key, id }
}

export function extractAgentProviderSession(
  source: AgentHookSource,
  payload: Record<string, unknown>
): AgentProviderSessionMetadata | null {
  switch (source) {
    // Native-chat agents: also capture the hook's authoritative transcript_path,
    // since recent Claude Code names the transcript file with a UUID that differs
    // from the hook session_id (so the id-based glob no longer finds it).
    case 'claude':
    case 'codex': {
      const id = readSessionId(payload, ['session_id'])
      return id ? withTranscriptPath({ key: 'session_id', id }, payload) : null
    }
    case 'gemini':
    case 'droid':
    // Why: Kimi Code posts a Claude-shaped `session_id` (e.g. session_<uuid>).
    case 'kimi': {
      const id = readSessionId(payload, ['session_id'])
      return id ? { key: 'session_id', id } : null
    }
    case 'antigravity': {
      const id = readSessionId(payload, ['conversationId'])
      return id ? { key: 'conversation_id', id } : null
    }
    case 'opencode':
    case 'mimo-code': {
      const id = readSessionId(payload, ['sessionID'])
      return id ? { key: 'session_id', id } : null
    }
    case 'grok': {
      const id = readSessionId(payload, ['sessionId', 'session_id'])
      return id ? { key: 'session_id', id } : null
    }
    case 'devin': {
      const id = readSessionId(payload, ['session_id', 'sessionId'])
      return id ? { key: 'session_id', id } : null
    }
    case 'amp':
    case 'cursor':
    case 'pi':
    case 'omp':
    case 'command-code':
    case 'copilot':
    case 'hermes':
      return null
  }
}

export function getAgentResumeArgv(
  agent: ResumableTuiAgent,
  providerSession: AgentProviderSessionMetadata
): string[] | null {
  const id = providerSession.id
  switch (agent) {
    case 'claude':
      return providerSession.key === 'session_id' ? ['claude', '--resume', id] : null
    case 'codex':
      return providerSession.key === 'session_id' ? ['codex', 'resume', id] : null
    case 'gemini':
      return providerSession.key === 'session_id' ? ['gemini', '--resume', id] : null
    case 'antigravity':
      return providerSession.key === 'conversation_id' ? ['agy', '--conversation', id] : null
    case 'opencode':
      return providerSession.key === 'session_id' ? ['opencode', '--session', id] : null
    case 'mimo-code':
      return providerSession.key === 'session_id' ? ['mimo', '--session', id] : null
    case 'droid':
      return providerSession.key === 'session_id' ? ['droid', '--resume', id] : null
    case 'grok':
      return providerSession.key === 'session_id' ? ['grok', '--resume', id] : null
    case 'devin':
      return providerSession.key === 'session_id' ? ['devin', '--resume', id] : null
  }
}
