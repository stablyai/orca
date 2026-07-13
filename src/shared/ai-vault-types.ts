import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  commandSeparator,
  quoteStartupArg,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './types'
import type { ExecutionHostId, ExecutionHostScope } from './execution-host'

// Local CLI agents scanned from on-disk transcripts (all TuiAgent).
const TUI_AI_VAULT_AGENTS = [
  'claude',
  'codex',
  'hermes',
  'pi',
  'omp',
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
  'kimi'
] as const satisfies readonly TuiAgent[]

// Why: web chat transcripts are imported read-only records, not a launchable
// CLI agent, so they aren't TuiAgent members.
export const WEB_CHAT_AGENTS = ['chatgpt', 'claude-web', 'gemini-web'] as const
export type WebChatAgent = (typeof WEB_CHAT_AGENTS)[number]

export const AI_VAULT_AGENTS = [...TUI_AI_VAULT_AGENTS, ...WEB_CHAT_AGENTS] as const

// Why: the aiVault.listSessions RPC schema CLAMPS scopePaths to this bound
// (safe: scope paths only widen discovery). Producer-side caps against the same
// value are optional belt-and-braces, not required for the request to succeed.
export const AI_VAULT_SCOPE_PATHS_MAX_COUNT = 64

export type AiVaultAgent = (typeof AI_VAULT_AGENTS)[number]
export type AiVaultScope = 'workspace' | 'project' | 'all'
export type AiVaultSort = 'updated' | 'created'
export type AiVaultGroup = 'project' | 'folder' | 'agent'

export function isWebChatAgent(agent: AiVaultAgent): agent is WebChatAgent {
  return (WEB_CHAT_AGENTS as readonly string[]).includes(agent)
}

export const AI_VAULT_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  hermes: 'Hermes',
  pi: 'Pi',
  omp: 'OMP',
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
  kimi: 'Kimi',
  chatgpt: 'ChatGPT',
  'claude-web': 'Claude.ai',
  'gemini-web': 'Gemini'
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
  // Recoverable signal for sessions whose conversation transcript persisted zero
  // user/assistant turns: queued (never-flushed) prompts survive even when the
  // main conversation was lost.
  queuedMessageCount: number
  // Number of Task subagent transcripts stored beside this session; always 0
  // for agents that don't materialize subagent transcripts. Doubles as the
  // recoverable signal for zero-turn sessions.
  subagentTranscriptCount: number
  resumeCommand: string
  // 읽기 전용 웹 대화는 CLI 이어하기가 없다. 렌더러가 이어하기 UI를 숨긴다.
  readOnly: boolean
  subagent: AiVaultSessionSubagentInfo | null
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
  path: string
  message: string
}

export type AiVaultListArgs = {
  limit?: number
  force?: boolean
  // Active workspace/project paths. The global result is recency-capped, so these
  // guarantee a scoped view still surfaces its own (possibly older) sessions.
  scopePaths?: readonly string[]
  executionHostScope?: ExecutionHostScope
  // User-configured cwd per web-chat agent. Web sessions are always host-local,
  // so this never crosses the remote runtime/SSH scan paths.
  webChatCwdByAgent?: Partial<Record<WebChatAgent, string>>
}

export type AiVaultListResult = {
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
  scannedAt: string
}

export function buildAiVaultResumeCommand(args: {
  agent: AiVaultAgent
  sessionId: string
  cwd: string | null
  platform: NodeJS.Platform
  commandOverride?: string | null
  codexHome?: string | null
  resumeFilePath?: string | null
  shell?: AgentStartupShell
}): string {
  const { agent, sessionId, cwd, platform, commandOverride, codexHome, resumeFilePath, shell } =
    args
  // Why: 웹 대화는 읽기 전용 — CLI 이어하기 명령이 없다(빈 문자열).
  if (isWebChatAgent(agent)) {
    return ''
  }
  const baseCommand = commandOverride?.trim() || defaultAiVaultResumeCommandBase(agent)
  // Why: OMP's `--resume` accepts an absolute transcript path, which resolves
  // regardless of which session-dir root (custom OMP_CODING_AGENT_DIR / WSL
  // home) the file was discovered under, where an id-prefix lookup scoped to
  // the default store would miss it. Falls back to the id if no path is known.
  const resumeTarget = agent === 'omp' && resumeFilePath?.trim() ? resumeFilePath.trim() : sessionId
  const sessionArg =
    shell === 'cmd'
      ? quoteWindowsCmdArg(resumeTarget)
      : shell
        ? quoteStartupArg(resumeTarget, shell)
        : quoteShellArg(resumeTarget, platform)
  const resumeCommand = buildAgentResumeInvocation(agent, baseCommand, sessionArg)

  return buildAiVaultResumeShellCommand({
    resumeCommand,
    cwd,
    platform,
    codexHome,
    shell
  })
}

export function buildAiVaultResumeShellCommand(args: {
  resumeCommand: string
  cwd: string | null
  platform: NodeJS.Platform
  codexHome?: string | null
  // Why: the QUEUED resume command is typed into the live tab shell, so its
  // cd/env prefix must match that shell. Shell-less persisted commands keep the
  // legacy self-contained `cmd /d /s /c` wrapper.
  shell?: AgentStartupShell
}): string {
  const { cwd, platform, codexHome, shell } = args

  // Why: shell-aware commands are parsed by a known running shell, while
  // shell-less persisted commands keep the legacy self-contained cmd wrapper.
  if (platform === 'win32' && shell && shell !== 'cmd') {
    return buildResumeShellCommandForShell({
      resumeCommand: args.resumeCommand,
      cwd,
      codexHome: codexHome?.trim() || null,
      shell
    })
  }

  const resumeCommand = `${codexHomeEnvPrefix(codexHome?.trim() || null, platform)}${
    args.resumeCommand
  }`
  if (platform === 'win32' && shell === 'cmd') {
    // Why: an interactive cmd splits the doubled quotes required by a nested
    // `cmd /s /c` wrapper, so queued commands must use direct cmd syntax.
    return cwd ? `cd /d ${quoteWindowsCmdArg(cwd)} && ${resumeCommand}` : resumeCommand
  }
  if (!cwd) {
    return resumeCommand
  }

  if (platform === 'win32') {
    const inner = `cd /d ${quoteWindowsCmdArg(cwd)} && ${resumeCommand}`
    return `cmd /d /s /c ${quoteWindowsCmdArg(inner)}`
  }

  return `cd ${quoteShellArg(cwd, platform)} && ${resumeCommand}`
}

function buildResumeShellCommandForShell(args: {
  resumeCommand: string
  cwd: string | null
  codexHome: string | null
  shell: Exclude<AgentStartupShell, 'cmd'>
}): string {
  const { cwd, codexHome, shell } = args
  if (shell === 'posix') {
    // Why: git-bash on a Windows host runs a POSIX shell, so reuse the same
    // inline-env + `cd '<cwd>'` prefix as the non-Windows path.
    const envPrefix = codexHome ? `CODEX_HOME=${quoteStartupArg(codexHome, shell)} ` : ''
    const command = `${envPrefix}${args.resumeCommand}`
    return cwd ? `cd ${quoteStartupArg(cwd, shell)} && ${command}` : command
  }

  const separator = commandSeparator(shell)
  const segments: string[] = []
  if (cwd) {
    segments.push(`Set-Location -LiteralPath ${quoteStartupArg(cwd, shell)}`)
  }
  if (codexHome) {
    segments.push(`$env:CODEX_HOME=${quoteStartupArg(codexHome, shell)}`)
  }
  segments.push(args.resumeCommand)
  return segments.join(separator)
}

export function aiVaultAgentLabel(agent: AiVaultAgent): string {
  return AI_VAULT_AGENT_LABELS[agent]
}

function defaultAiVaultResumeCommandBase(agent: Exclude<AiVaultAgent, WebChatAgent>): string {
  if (agent === 'cursor') {
    return 'cursor-agent'
  }
  if (agent === 'hermes') {
    return 'hermes'
  }
  if (agent === 'rovo') {
    return 'acli'
  }
  return TUI_AGENT_CONFIG[agent].detectCmd
}

function buildAgentResumeInvocation(
  agent: Exclude<AiVaultAgent, WebChatAgent>,
  baseCommand: string,
  sessionArg: string
): string {
  switch (agent) {
    case 'codex':
      return `${baseCommand} resume ${sessionArg}`
    case 'rovo':
      return `${baseCommand} rovodev run --restore ${sessionArg}`
    case 'opencode':
    case 'pi':
    // Why: Kimi Code resumes with `kimi --session <id>` (alias `-S`). Sessions
    // are work-dir-scoped, so the cwd prefix from buildAiVaultResumeCommand is
    // required — resuming from another directory is rejected by the CLI.
    case 'kimi':
      return `${baseCommand} --session ${sessionArg}`
    case 'copilot':
      return `${baseCommand} --resume=${sessionArg}`
    // Why: Antigravity resumes a conversation by its id (the .db filename)
    // via `agy --conversation <id>`, unlike the `--resume` family below.
    case 'antigravity':
      return `${baseCommand} --conversation ${sessionArg}`
    case 'claude':
    case 'cursor':
    case 'gemini':
    case 'grok':
    case 'hermes':
    case 'devin':
    case 'openclaw':
    case 'droid':
    // Why: OMP resumes by absolute transcript path (see buildAiVaultResumeCommand),
    // but the `--resume <arg>` invocation form is identical to the others here.
    case 'omp':
      return `${baseCommand} --resume ${sessionArg}`
  }
}

function codexHomeEnvPrefix(codexHome: string | null, platform: NodeJS.Platform): string {
  if (!codexHome) {
    return ''
  }
  if (platform === 'win32') {
    return `set ${quoteWindowsCmdArg(`CODEX_HOME=${codexHome}`)} && `
  }
  return `CODEX_HOME=${quoteShellArg(codexHome, platform)} `
}

function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return quoteWindowsCmdArg(value)
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
