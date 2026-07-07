import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  commandSeparator,
  quoteStartupArg,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './types'
import type { ExecutionHostId, ExecutionHostScope } from './execution-host'

export const AI_VAULT_AGENTS = [
  'claude',
  'codex',
  'hermes',
  'pi',
  'omp',
  'cursor',
  'gemini',
  'rovo',
  'copilot',
  'opencode',
  'grok',
  'openclaw',
  'devin',
  'droid',
  'kimi'
] as const satisfies readonly TuiAgent[]

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
  cursor: 'Cursor',
  gemini: 'Gemini',
  rovo: 'Rovo Dev',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  grok: 'Grok',
  openclaw: 'OpenClaw',
  devin: 'Devin',
  droid: 'Droid',
  kimi: 'Kimi'
} as const satisfies Record<AiVaultAgent, string>

export type AiVaultSessionPreviewMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown'
  text: string
  timestamp: string | null
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
  resumeCommand: string
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
  const baseCommand = commandOverride?.trim() || defaultAiVaultResumeCommandBase(agent)
  // Why: OMP's `--resume` accepts an absolute transcript path, which resolves
  // regardless of which session-dir root (custom OMP_CODING_AGENT_DIR / WSL
  // home) the file was discovered under, where an id-prefix lookup scoped to
  // the default store would miss it. Falls back to the id if no path is known.
  const resumeTarget = agent === 'omp' && resumeFilePath?.trim() ? resumeFilePath.trim() : sessionId
  const sessionArg = shell
    ? quoteStartupArg(resumeTarget, shell)
    : quoteShellArg(resumeTarget, platform)
  const resumeCommand = buildAgentResumeInvocation(agent, baseCommand, sessionArg)

  return buildAiVaultResumeShellCommand({ resumeCommand, cwd, platform, codexHome, shell })
}

export function buildAiVaultResumeShellCommand(args: {
  resumeCommand: string
  cwd: string | null
  platform: NodeJS.Platform
  codexHome?: string | null
  // Why: the QUEUED resume command is typed into the live tab shell, so its
  // cd/env prefix must match that shell. The copy-to-clipboard string omits this
  // and keeps the self-contained `cmd /d /s /c` wrapper (its documented purpose).
  shell?: AgentStartupShell
}): string {
  const { cwd, platform, codexHome, shell } = args

  // Why: on Windows the queued command must target the configured live shell
  // (default PowerShell). PowerShell mis-parses the cmd `""`-doubled wrapper and
  // reports "operable program or batch file", so only re-wrap with cmd when the
  // live shell actually is cmd (or when no shell is given, i.e. the copy path).
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

function defaultAiVaultResumeCommandBase(agent: AiVaultAgent): string {
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
  agent: AiVaultAgent,
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
