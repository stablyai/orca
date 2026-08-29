import type { TuiAgent } from './tui-agent'
import type { ExecutionHostId, ExecutionHostScope } from './execution-host'

export const AI_VAULT_AGENTS = [
  'claude',
  'codex',
  'hermes',
  'pi',
  'omp',
  'prime-agent',
  'cursor',
  'gemini',
  'antigravity',
  'rovo',
  'copilot',
  'opencode',
  'grok',
  'openclaw',
  'devin',
  'droid',
  'cline',
  'kimi'
] as const satisfies readonly TuiAgent[]

// Why: the aiVault.listSessions RPC schema CLAMPS scopePaths to this bound
// (safe: scope paths only widen discovery). Producer-side caps against the same
// value are optional belt-and-braces, not required for the request to succeed.
export const AI_VAULT_SCOPE_PATHS_MAX_COUNT = 64

// Why: IPC rejection drops `Error.name`, so the renderer can only recognise a
// cancelled scan by its message. Both sides share this literal.
export const AI_VAULT_SCAN_CANCELLED_MESSAGE = 'Agent Session History scan was cancelled'

export function isAiVaultScanCancelledError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes(AI_VAULT_SCAN_CANCELLED_MESSAGE))
  )
}

export type AiVaultAgent = (typeof AI_VAULT_AGENTS)[number]
export type AiVaultScope = 'workspace' | 'project' | 'all'
export type AiVaultSort = 'updated' | 'created'
export type AiVaultGroup = 'project' | 'folder' | 'agent'

export const AI_VAULT_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  hermes: 'Hermes',
  pi: 'Pi',
  omp: 'OMP',
  'prime-agent': 'Prime Agent',
  cursor: 'Cursor',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  rovo: 'Rovo Dev',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  grok: 'Grok',
  openclaw: 'OpenClaw',
  devin: 'Devin',
  droid: 'Droid',
  cline: 'Cline',
  kimi: 'Kimi'
} as const satisfies Record<AiVaultAgent, string>

export type AiVaultSessionPreviewMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown'
  text: string
  timestamp: string | null
}

// Terminal statuses come from <task-notification> records in the parent
// transcript; 'running' is inferred from recent transcript activity.
export type AiVaultSubagentRunStatus = 'running' | 'completed' | 'failed' | 'stopped'

// Set only on Task subagent transcript rows (listed on demand under their
// parent session); null for every top-level scanned session.
export type AiVaultSessionSubagentInfo = {
  parentSessionId: string
  agentType: string | null
  status: AiVaultSubagentRunStatus | null
}

export type AiVaultSession = {
  id: string
  executionHostId: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  agent: AiVaultAgent
  sessionId: string
  title: string
  cwd: string | null
  branch: string | null
  model: string | null
  filePath: string
  codexHome: string | null
  createdAt: string | null
  updatedAt: string | null
  modifiedAt: string
  messageCount: number
  totalTokens: number
  previewMessages: AiVaultSessionPreviewMessage[]
  /** Older messages fell out of the newest-N window: the earliest preview turn
   * is NOT the opening ask, so first-prompt consumers must not scan it. */
  previewMessagesTruncated?: boolean
  /**
   * Full first non-injected user prompt. List scans omit this (payload/perf);
   * populated only by on-demand `aiVault.getFirstUserPrompt` re-parses for copy.
   */
  firstUserPrompt?: string | null
  /** Latest provider-authenticated user prompt; absent when the transcript has no trustworthy signal. */
  lastUserPrompt?: string | null
  // Recoverable signal for sessions whose conversation transcript persisted zero
  // user/assistant turns: queued (never-flushed) prompts survive even when the
  // main conversation was lost.
  queuedMessageCount: number
  // Number of Task subagent transcripts stored beside this session; always 0
  // for agents that don't materialize subagent transcripts. Doubles as the
  // recoverable signal for zero-turn sessions.
  subagentTranscriptCount: number
  resumeCommand: string
  subagent: AiVaultSessionSubagentInfo | null
  /** Present only when the negotiated client can open the native structured owner. */
  structuredSession?: {
    sessionId: string
    workspaceId: string
  }
}

export type AiVaultSubagentListArgs = {
  agent: AiVaultAgent
  parentFilePath: string
  // The session's host. Subagent transcripts are read from the local
  // filesystem, so non-local hosts resolve to an empty list.
  executionHostId?: ExecutionHostId
}

export type AiVaultSubagentListResult = {
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
}

/** On-demand full first-prompt read for Agent Session History copy/reuse. */
export type AiVaultFirstUserPromptArgs = {
  agent: AiVaultAgent
  filePath: string
  // Required for OpenCode SQLite rows (filePath is the db; session is a row id).
  sessionId?: string
  // Transcripts are local-FS only; non-local hosts resolve to null prompt.
  executionHostId?: ExecutionHostId
  codexHome?: string | null
}

export type AiVaultFirstUserPromptResult = {
  prompt: string | null
}

// A session is only offered for normal resume when its transcript actually holds
// conversation turns; resuming a zero-turn transcript lands in an empty session.
// Conversation previews count as evidence too: some parsers (e.g. Grok, OpenCode
// fallback schemas) only learn the turn count from metadata that may be absent.
export function isAiVaultSessionResumableContent(
  session: Pick<AiVaultSession, 'messageCount' | 'previewMessages'>
): boolean {
  return (
    session.messageCount > 0 ||
    session.previewMessages.some(
      (message) => message.role === 'user' || message.role === 'assistant'
    )
  )
}

export function aiVaultSessionRecoverableSignalCount(
  session: Pick<AiVaultSession, 'queuedMessageCount' | 'subagentTranscriptCount'>
): number {
  return Math.max(0, session.queuedMessageCount) + Math.max(0, session.subagentTranscriptCount)
}

// Zero-turn transcript that still carries recoverable content (queued prompts
// and/or subagent transcripts). Surfaced distinctly instead of hidden as empty.
export function isAiVaultSessionRecoverableEmpty(
  session: Pick<
    AiVaultSession,
    'messageCount' | 'previewMessages' | 'queuedMessageCount' | 'subagentTranscriptCount'
  >
): boolean {
  return (
    !isAiVaultSessionResumableContent(session) && aiVaultSessionRecoverableSignalCount(session) > 0
  )
}

export type AiVaultScanIssue = {
  executionHostId?: ExecutionHostId
  agent: AiVaultAgent
  // 'notice' rows are scanner commentary (issue-list overflow), never a failure.
  kind?: 'host' | 'scope' | 'notice'
  path: string
  message: string
}

export type AiVaultListArgs = {
  limit?: number
  unlimited?: boolean
  force?: boolean
  // Active workspace/project paths. The global result is recency-capped, so these
  // guarantee a scoped view still surfaces its own (possibly older) sessions.
  scopePaths?: readonly string[]
  executionHostScope?: ExecutionHostScope
  requestToken?: string
}

export type AiVaultListResult = {
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
  scannedAt: string
  /** Set only by the desktop IPC boundary: this scan was superseded, so its empty body means "nothing to apply". */
  cancelled?: true
}

export function aiVaultAgentLabel(agent: AiVaultAgent): string {
  return AI_VAULT_AGENT_LABELS[agent]
}
