import type { AgentHookSource } from './agent-hook-relay'
import type { AgentStatusState } from './agent-status-types'
import type { AgentMainAgentStatus } from './main-agent-status'
import type { TuiAgent } from './tui-agent'

export const RESUMABLE_TUI_AGENTS = [
  'claude',
  'codebuddy',
  'codex',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'gemini',
  'antigravity',
  'opencode',
  'opencode2',
  'pi',
  'mimo-code',
  'droid',
  'grok',
  'devin',
  'omp',
  'prime-agent',
  'copilot',
  'cursor',
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'kiro'
] as const satisfies readonly TuiAgent[]

export type ResumableTuiAgent = (typeof RESUMABLE_TUI_AGENTS)[number]

export type AgentProviderSessionKey = 'session_id' | 'conversation_id'

export type AgentProviderSessionMetadata = {
  key: AgentProviderSessionKey
  id: string
  /** Prefer hook-reported transcript paths: recent Claude filenames differ from session_id. Claude/Codex still resume by ID; Pi uses session_file as its --session locator. */
  transcriptPath?: string
}

export type SleepingAgentLaunchConfig = {
  agentCommand?: string
  agentArgs: string
  agentEnv: Record<string, string>
  ompResumeFilePath?: string
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
  /** The main agent's own status when captured, copied with `interrupted` by `agentVerdictFields`;
   *  read the verdict through `agentMainAgentVerdict`. */
  mainAgent?: AgentMainAgentStatus
  connectionId?: string | null
  launchConfig?: SleepingAgentLaunchConfig
  /** Worktree-sleep/legacy records open fresh tabs on activation. quit/live records belong to restored panes; only their cold-restore path consumes them to avoid duplicating warm sessions (#5232). */
  origin?: 'worktree-sleep' | 'quit' | 'live'
  /** Explicit-sleep finished panes resume only when their own tab opens; mobile wake must not mount/respawn every slept tab (#11598). */
  restoreOnTabOpenOnly?: boolean
}

/** A record of a slept pane (worktree sleep, or a legacy record); 'quit'/'live' resume a running agent. */
export function isPaneSleepRecord(record: Pick<SleepingAgentSessionRecord, 'origin'>): boolean {
  return record.origin === undefined || record.origin === 'worktree-sleep'
}

/** Only host-wake sleep records count: live/quit panes restore themselves, and tab-open-only panes wait for their tab. */
export function hasSleptAgentToWake(
  records: Record<string, SleepingAgentSessionRecord> | undefined,
  worktreeId: string
): boolean {
  return Object.values(records ?? {}).some(
    (record) =>
      record.worktreeId === worktreeId &&
      isPaneSleepRecord(record) &&
      record.restoreOnTabOpenOnly !== true
  )
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

/** Read the hook-reported transcript path; recent Claude filenames cannot be reconstructed from session ID. */
function readTranscriptPathFromKeys(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw !== 'string') {
      continue
    }
    const trimmed = raw.trim()
    if (trimmed && !hasUnsafeProviderSessionIdChars(trimmed)) {
      return trimmed
    }
  }
  return undefined
}

function withTranscriptPath(
  metadata: AgentProviderSessionMetadata,
  payload: Record<string, unknown>,
  keys: readonly string[] = ['transcript_path', 'transcriptPath']
): AgentProviderSessionMetadata {
  const transcriptPath = readTranscriptPathFromKeys(payload, keys)
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
  // Persisted/relay paths cross trust boundaries too; reject controls as for hook paths.
  const transcriptPath = readTranscriptPathFromKeys(record, ['transcriptPath'])
  return transcriptPath ? { key, id, transcriptPath } : { key, id }
}

/** Compare the provider-owned values that identify the CLI resume target.
 *  Pi-family transcript resumes use file identity; other agents use provider ids. */
export function agentProviderSessionsEqual(
  agent: string | undefined,
  left: AgentProviderSessionMetadata | undefined,
  right: AgentProviderSessionMetadata | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return (
    left.key === right.key &&
    left.id === right.id &&
    ((agent !== 'pi' && agent !== 'prime-agent') || left.transcriptPath === right.transcriptPath)
  )
}

export function extractAgentProviderSession(
  source: AgentHookSource,
  payload: Record<string, unknown>
): AgentProviderSessionMetadata | null {
  switch (source) {
    // Capture transcript_path: recent Claude filenames differ from hook session_id, defeating ID-based globs.
    case 'qoder-cn':
    case 'qwen-code':
    case 'qoder':
    case 'codebuddy':
    case 'claude':
    case 'codex': {
      const id = readSessionId(payload, ['session_id'])
      return id ? withTranscriptPath({ key: 'session_id', id }, payload) : null
    }
    case 'gemini':
    case 'droid':
    // Why: Kimi Code posts a Claude-shaped `session_id` (e.g. session_<uuid>).
    // falls through
    case 'kimi': {
      const id = readSessionId(payload, ['session_id'])
      return id ? { key: 'session_id', id } : null
    }
    case 'muse': {
      const id = readSessionId(payload, ['session_id'])
      return id ? withTranscriptPath({ key: 'session_id', id }, payload) : null
    }
    // ZCode deletes its per-invocation transcript_path temp file when the hook returns; only its ID is durable.
    case 'zcode': {
      const id = readSessionId(payload, ['session_id'])
      return id ? { key: 'session_id', id } : null
    }
    // DSH's bridge has no persistence artifact and sends an empty transcript_path; retain its session ID only.
    // Kiro also reports no transcript path; its ID feeds --resume-id.
    case 'kiro':
    case 'dsh': {
      const id = readSessionId(payload, ['session_id'])
      return id ? { key: 'session_id', id } : null
    }
    case 'antigravity': {
      const id = readSessionId(payload, ['conversationId'])
      return id ? { key: 'conversation_id', id } : null
    }
    case 'opencode':
    case 'opencode2':
    case 'mimo-code': {
      const id = readSessionId(payload, ['sessionID'])
      return id ? { key: 'session_id', id } : null
    }
    case 'pi':
    case 'prime-agent': {
      const id = readSessionId(payload, ['session_id'])
      const providerSession = id
        ? withTranscriptPath({ key: 'session_id', id }, payload, ['session_file'])
        : null
      return providerSession?.transcriptPath ? providerSession : null
    }
    case 'grok': {
      const id = readSessionId(payload, ['sessionId', 'session_id'])
      return id ? { key: 'session_id', id } : null
    }
    case 'devin': {
      const id = readSessionId(payload, ['session_id', 'sessionId'])
      return id ? { key: 'session_id', id } : null
    }
    case 'jcode': {
      const id = readSessionId(payload, ['session_id', 'sessionId'])
      return id ? { key: 'session_id', id } : null
    }
    // OMP keeps id-based resume while optionally locating its native-chat transcript.
    case 'omp': {
      const id = readSessionId(payload, ['session_id'])
      return id ? withTranscriptPath({ key: 'session_id', id }, payload, ['session_file']) : null
    }
    // Why: Copilot's hook `session_id` is also its `~/.copilot/session-state/<id>/`
    // directory name, so the same id is the CLI's resume locator.
    case 'copilot': {
      const id = readSessionId(payload, ['session_id', 'sessionId'])
      return id ? { key: 'session_id', id } : null
    }
    case 'cursor': {
      const id = readSessionId(payload, ['conversation_id'])
      return id ? { key: 'conversation_id', id } : null
    }
    case 'amp':
    case 'command-code':
    case 'hermes':
      return null
  }
}

// Preserve the existing import path.
export { getAgentForkArgv, getAgentResumeArgv } from './agent-resume-argv'
