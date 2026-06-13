import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './types'

export const AI_VAULT_AGENTS = [
  'claude',
  'codex',
  'hermes',
  'pi',
  'cursor',
  'gemini',
  'rovo',
  'copilot',
  'opencode',
  'grok',
  'openclaw',
  'droid'
] as const satisfies readonly TuiAgent[]

export type AiVaultAgent = (typeof AI_VAULT_AGENTS)[number]
export type AiVaultScope = 'workspace' | 'all'
export type AiVaultSort = 'updated' | 'created'
export type AiVaultGroup = 'folder' | 'agent'

export const AI_VAULT_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  hermes: 'Hermes',
  pi: 'Pi',
  cursor: 'Cursor',
  gemini: 'Gemini',
  rovo: 'Rovo Dev',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  grok: 'Grok',
  openclaw: 'OpenClaw',
  droid: 'Droid'
} as const satisfies Record<AiVaultAgent, string>

export type AiVaultSessionPreviewMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown'
  text: string
  timestamp: string | null
}

export type AiVaultSession = {
  id: string
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
  agent: AiVaultAgent
  path: string
  message: string
}

export type AiVaultListArgs = {
  limit?: number
  force?: boolean
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
}): string {
  const { agent, sessionId, cwd, platform, commandOverride, codexHome } = args
  const baseCommand = commandOverride?.trim() || defaultAiVaultResumeCommandBase(agent)
  const sessionArg = quoteShellArg(sessionId, platform)
  const resumeCommand = buildAgentResumeInvocation(agent, baseCommand, sessionArg, {
    codexHome: codexHome?.trim() || null,
    platform
  })

  if (!cwd) {
    return resumeCommand
  }

  if (platform === 'win32') {
    const inner = `cd /d ${quoteWindowsCmdArg(cwd)} && ${resumeCommand}`
    return `cmd /d /s /c ${quoteWindowsCmdArg(inner)}`
  }

  return `cd ${quoteShellArg(cwd, platform)} && ${resumeCommand}`
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
  sessionArg: string,
  options: { codexHome: string | null; platform: NodeJS.Platform }
): string {
  switch (agent) {
    case 'codex':
      return `${codexHomeEnvPrefix(options.codexHome, options.platform)}${baseCommand} resume ${sessionArg}`
    case 'rovo':
      return `${baseCommand} rovodev run --restore ${sessionArg}`
    case 'opencode':
    case 'pi':
      return `${baseCommand} --session ${sessionArg}`
    case 'copilot':
      return `${baseCommand} --resume=${sessionArg}`
    case 'claude':
    case 'cursor':
    case 'gemini':
    case 'grok':
    case 'hermes':
    case 'openclaw':
    case 'droid':
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
