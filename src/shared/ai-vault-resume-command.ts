// Resume-command construction for Agent Session History rows: turns a scanned
// session into the shell line that re-enters it, quoted for the target platform
// and (when known) the live tab's shell.
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  commandSeparator,
  isPosixStartupShell,
  quoteStartupArg,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { AiVaultAgent, AiVaultSession } from './ai-vault-types'

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
  // Why: OMP's and Prime Agent's `--resume` accept an absolute transcript path,
  // which resolves regardless of which session-dir root (custom
  // OMP_CODING_AGENT_DIR / PRIME_AGENT_CODING_AGENT_DIR / WSL home) the file was
  // discovered under, where an id-prefix lookup scoped to the default store
  // would miss it. Falls back to the id if no path is known.
  const resumeTarget =
    (agent === 'omp' || agent === 'prime-agent') && resumeFilePath?.trim()
      ? resumeFilePath.trim()
      : sessionId
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
  if (isPosixStartupShell(shell)) {
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

// Why: a bare real-home resume carries no CODEX_HOME prefix, so every surface
// that spawns the pane must drop account-routed or daemon-inherited Codex
// homes from its env, not only patch a sparse env on top.
export function realHomeCodexResumeEnvDeletion(
  session: Pick<AiVaultSession, 'agent' | 'codexHome'>
): { envToDelete: string[] } | Record<string, never> {
  if (session.agent !== 'codex' || session.codexHome !== null) {
    return {}
  }
  return { envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'] }
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
    // falls through
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
    // Why: OMP and Prime Agent resume by absolute transcript path (see
    // buildAiVaultResumeCommand), but the `--resume <arg>` invocation form is
    // identical to the others here.
    // falls through
    case 'omp':
    case 'prime-agent':
      return `${baseCommand} --resume ${sessionArg}`
    case 'antigravity':
      return `${baseCommand} --conversation ${sessionArg}`
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
