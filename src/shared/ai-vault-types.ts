import type { TuiAgent } from './tui-agent'
import type { ExecutionHostId, ExecutionHostScope } from './execution-host'

export const AI_VAULT_AGENTS = [
  'claude',
  'codebuddy',
  'qoder',
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
  'opencode2',
  'zcode',
  'grok',
  'openclaw',
  'devin',
  'droid',
  'cline',
  'kimi',
  'muse',
  'jcode',
  'kiro'
] as const satisfies readonly TuiAgent[]

// RPC clamps scopePaths to this bound because paths only widen discovery; matching producer-side caps are optional.
export const AI_VAULT_SCOPE_PATHS_MAX_COUNT = 64

// IPC drops Error.name; recognize cancelled scans by this shared message literal.
export const AI_VAULT_SCAN_CANCELLED_MESSAGE = 'Agent Session History scan was cancelled'

export function isAiVaultScanCancelledError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes(AI_VAULT_SCAN_CANCELLED_MESSAGE))
  )
}

export type AiVaultAgent = (typeof AI_VAULT_AGENTS)[number]

export function isAiVaultAgent(value: unknown): value is AiVaultAgent {
  return AI_VAULT_AGENTS.some((agent) => agent === value)
}

/** The agents Session History may list `agent`'s sessions under. */
export function aiVaultHistoryAgents(agent: AiVaultAgent): AiVaultAgent[] {
  // One OpenCode store holds both versions' sessions, and the scanner labels current ones `opencode2`.
  return agent === 'opencode' || agent === 'opencode2' ? ['opencode', 'opencode2'] : [agent]
}

export type AiVaultScope = 'workspace' | 'project' | 'all'
export type AiVaultSort = 'updated' | 'created'
export const AI_VAULT_SEARCH_SORTS = ['relevance', 'newest'] as const
/** Order of full-text search results; the list above has its own `AiVaultSort`. */
export type AiVaultSearchSort = (typeof AI_VAULT_SEARCH_SORTS)[number]
export type AiVaultGroup = 'project' | 'folder' | 'agent'

export const AI_VAULT_AGENT_LABELS = {
  claude: 'Claude',
  codebuddy: 'CodeBuddy',
  qoder: 'Qoder',
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
  opencode2: 'OpenCode 2',
  zcode: 'ZCode',
  grok: 'Grok',
  openclaw: 'OpenClaw',
  devin: 'Devin',
  droid: 'Droid',
  cline: 'Cline',
  kimi: 'Kimi',
  muse: 'Muse',
  jcode: 'Jcode',
  kiro: 'Kiro'
} as const satisfies Record<AiVaultAgent, string>

export type AiVaultSessionPreviewMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown'
  text: string
  timestamp: string | null
}

// Parent task-notification records report terminal status; recent transcript activity implies running.
export type AiVaultSubagentRunStatus = 'running' | 'completed' | 'failed' | 'stopped'

// Only on on-demand Task child rows; null for top-level scans.
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
  /** The host's spellings of `cwd` under a symlinked scope path. Scope matching only; resume reads `cwd`. */
  cwdAliases?: string[]
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
  /** The opening ask fell outside the newest-N window; first-prompt readers must not search the surviving preview. */
  previewMessagesTruncated?: boolean
  /** Bounded opening-prompt identity for Antigravity history joins; never a rolling preview. */
  antigravityOpeningPrompt?: { hash: string; timestamp: string | null }
  /** Full first non-injected prompt only on on-demand getFirstUserPrompt reparses; list scans omit it for payload/cost. */
  firstUserPrompt?: string | null
  /** Latest provider-authenticated user prompt; absent when the transcript has no trustworthy signal. */
  lastUserPrompt?: string | null
  // Queued unflushed prompts preserve recovery evidence even when conversation turns were lost.
  queuedMessageCount: number
  // Task transcript count doubles as zero-turn recovery evidence; zero for agents without child transcripts.
  subagentTranscriptCount: number
  resumeCommand: string
  subagent: AiVaultSessionSubagentInfo | null
  /** Present only when the negotiated client can open the native structured owner. */
  structuredSession?: {
    sessionId: string
    workspaceId: string
  }
  /** The client's pairing with the listing server when it listed this row; host mutations are fenced to it. */
  hostPairingRevision?: number
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

// Offer normal resume only with real conversation evidence. Count previews too when parser metadata lacks turns; zero-turn files otherwise reopen empty.
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

// Show zero-turn queued/subagent recovery content distinctly instead of hiding it as empty.
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
  /** Opts a selected runtime-host refresh into content-conditional replies. */
  afterFingerprint?: string | null
  /** Opt-in promises this client starts IDE history in a new CLI conversation. */
  includeAntigravityIdeSessions?: boolean
  limit?: number
  unlimited?: boolean
  force?: boolean
  // Scope paths preserve older relevant sessions outside the globally recency-capped result.
  scopePaths?: readonly string[]
  executionHostScope?: ExecutionHostScope
  requestToken?: string
}

export type AiVaultListResult = {
  /** Local scan entry that produced this result; absent for remote and merged results. */
  scanId?: string
  fingerprint?: string
  /** Requires the caller to reuse the exact previously received body. */
  unchanged?: true
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
  scannedAt: string
  /** Set only by the desktop IPC boundary: this scan was superseded, so its empty body means "nothing to apply". */
  cancelled?: true
}

export function aiVaultAgentLabel(agent: AiVaultAgent): string {
  return AI_VAULT_AGENT_LABELS[agent]
}
