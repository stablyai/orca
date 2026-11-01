// Build history resume lines for the execution platform and actual shell.
import { quoteCmdDoubleQuoted } from './shell-argument-quoting'
import {
  isAntigravityReferenceSession,
  antigravityTranscriptReferencePrompt
} from './antigravity-session-origin'
import { normalizeAiVaultResumeFilePath } from './ai-vault-resume-path'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  clearEnvCommand,
  commandSeparator,
  isPosixStartupShell,
  quoteStartupArg,
  type AgentStartupShell,
  withoutEnvCommand
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
  clearEnvNames?: readonly string[]
}): string {
  const { agent, sessionId, cwd, platform, commandOverride, codexHome, resumeFilePath, shell } =
    args
  const baseCommand = commandOverride?.trim() || defaultAiVaultResumeCommandBase(agent)
  // OMP/Prime --resume accepts absolute transcript paths across custom roots/WSL; default-store ID lookup would miss them. Fall back to ID without a path.
  const resumeTarget =
    (agent === 'omp' || agent === 'prime-agent') && resumeFilePath?.trim()
      ? resumeFilePath.trim()
      : sessionId
  const sessionArg =
    shell === 'cmd'
      ? quoteCmdDoubleQuoted(resumeTarget)
      : shell
        ? quoteStartupArg(resumeTarget, shell)
        : quoteShellArg(resumeTarget, platform)
  const referencePath = normalizeAiVaultResumeFilePath(resumeFilePath ?? undefined, platform)
  const resumeCommand =
    isAntigravityReferenceSession({ agent, filePath: referencePath }) && referencePath
      ? `${baseCommand} --prompt-interactive ${quoteResumeArg(antigravityTranscriptReferencePrompt(referencePath), platform, shell)}`
      : buildAgentResumeInvocation(agent, baseCommand, sessionArg)

  return buildAiVaultResumeShellCommand({
    resumeCommand,
    cwd,
    platform,
    codexHome,
    shell,
    clearEnvNames: args.clearEnvNames
  })
}

export function buildAiVaultResumeShellCommand(args: {
  resumeCommand: string
  cwd: string | null
  platform: NodeJS.Platform
  codexHome?: string | null
  /** Remove env on the agent itself: env cannot run builtin cd and a child cd would not move the agent. */
  clearEnvNames?: readonly string[]
  // Queued lines run in the live shell; persisted shell-less commands retain the self-contained cmd /d /s /c wrapper.
  shell?: AgentStartupShell
}): string {
  const { cwd, platform, codexHome, shell, clearEnvNames } = args

  // Choose grammar by live shell, including PowerShell on POSIX; shell-less persisted lines retain the legacy cmd wrapper.
  if (shell === 'powershell' || (platform === 'win32' && shell && shell !== 'cmd')) {
    return buildResumeShellCommandForShell({
      resumeCommand: args.resumeCommand,
      cwd,
      codexHome: codexHome?.trim() || null,
      shell,
      clearEnvNames
    })
  }

  const resolvedCodexHome = codexHome?.trim() || null
  // Filter assignments from env -u so the explicitly pinned home stays authoritative, matching legacy clear-then-assign ordering.
  const clearNames = resolvedCodexHome
    ? clearEnvNames?.filter((name) => name !== 'CODEX_HOME')
    : clearEnvNames
  // POSIX set -u rejects the clear statement's unbound fish_pid: remove env on the agent. cmd can clear before cd, preserving cd-failure short-circuiting. Choose by shell, not host.
  const dialect = shell ?? (platform === 'win32' ? 'cmd' : 'posix')
  const clearsOnAgent = clearNames?.length && isPosixStartupShell(dialect)
  const resumeCommand = `${codexHomeEnvPrefix(resolvedCodexHome, platform, shell)}${
    clearsOnAgent ? withoutEnvCommand(clearNames, args.resumeCommand, dialect) : args.resumeCommand
  }`
  const clearPrefix =
    clearNames?.length && !clearsOnAgent
      ? `${clearEnvCommand(clearNames, dialect)}${commandSeparator(dialect)}`
      : ''
  if (platform === 'win32' && shell === 'cmd') {
    // Interactive cmd splits nested-wrapper doubled quotes; queued lines need direct cmd syntax.
    return `${clearPrefix}${cwd ? `cd /d ${quoteCmdDoubleQuoted(cwd)} && ${resumeCommand}` : resumeCommand}`
  }
  if (!cwd) {
    return `${clearPrefix}${resumeCommand}`
  }

  if (platform === 'win32') {
    const inner = `${clearPrefix}cd /d ${quoteCmdDoubleQuoted(cwd)} && ${resumeCommand}`
    return `cmd /d /s /c ${quoteCmdDoubleQuoted(inner)}`
  }

  return `cd ${quoteResumeArg(cwd, platform, shell)} && ${resumeCommand}`
}

function buildResumeShellCommandForShell(args: {
  resumeCommand: string
  cwd: string | null
  codexHome: string | null
  shell: Exclude<AgentStartupShell, 'cmd'>
  clearEnvNames?: readonly string[]
}): string {
  const { cwd, codexHome, shell, clearEnvNames } = args
  if (isPosixStartupShell(shell)) {
    // Windows Git Bash needs POSIX inline env and cd quoting.
    const envPrefix = codexHome ? `CODEX_HOME=${quoteStartupArg(codexHome, shell)} ` : ''
    // Do not let env -u remove the explicitly assigned home.
    const clearNames = codexHome
      ? clearEnvNames?.filter((name) => name !== 'CODEX_HOME')
      : clearEnvNames
    const command = `${envPrefix}${
      clearNames?.length
        ? withoutEnvCommand(clearNames, args.resumeCommand, shell)
        : args.resumeCommand
    }`
    return cwd ? `cd ${quoteStartupArg(cwd, shell)} && ${command}` : command
  }

  const separator = commandSeparator(shell)
  const segments: string[] = []
  // PowerShell has no set -u hazard; keep removal before Set-Location.
  if (clearEnvNames?.length) {
    segments.push(clearEnvCommand(clearEnvNames, shell))
  }
  if (cwd) {
    segments.push(`Set-Location -LiteralPath ${quoteStartupArg(cwd, shell)}`)
  }
  if (codexHome) {
    segments.push(`$env:CODEX_HOME=${quoteStartupArg(codexHome, shell)}`)
  }
  segments.push(args.resumeCommand)
  return segments.join(separator)
}

// Real-home resumes have no CODEX_HOME prefix: every spawning surface must delete inherited account/daemon homes instead of overlaying sparse env.
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
  // Preserve launch subcommands and mode flags when resuming.
  if (agent === 'rovo' || agent === 'opencode2' || agent === 'kiro') {
    return TUI_AGENT_CONFIG[agent].launchCmd
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
      // Why: the base is the full launch command, as a settings override is.
      return `${baseCommand} --restore ${sessionArg}`
    case 'opencode2':
    case 'opencode':
    case 'pi':
    // Kimi --session/-S is workspace-scoped; retain the cwd prefix or resume fails.
    // falls through
    case 'kimi':
      return `${baseCommand} --session ${sessionArg}`
    case 'copilot':
      return `${baseCommand} --resume=${sessionArg}`
    // Muse resume is workspace-scoped; retain the cwd prefix.
    case 'muse':
      return `${baseCommand} resume ${sessionArg}`
    case 'cline':
      return `${baseCommand} --id ${sessionArg}`
    case 'qoder':
    case 'codebuddy':
    case 'claude':
    case 'zcode':
    case 'cursor':
    case 'gemini':
    case 'grok':
    case 'hermes':
    case 'devin':
    case 'openclaw':
    case 'droid':
    case 'jcode':
    // OMP/Prime use the same --resume form with absolute transcript paths.
    // falls through
    case 'omp':
    case 'prime-agent':
      return `${baseCommand} --resume ${sessionArg}`
    case 'antigravity':
      return `${baseCommand} --conversation ${sessionArg}`
    case 'kiro':
      return `${baseCommand} --resume-id ${sessionArg}`
  }
}

function codexHomeEnvPrefix(
  codexHome: string | null,
  platform: NodeJS.Platform,
  shell?: AgentStartupShell
): string {
  if (!codexHome) {
    return ''
  }
  if (platform === 'win32') {
    return `set ${quoteCmdDoubleQuoted(`CODEX_HOME=${codexHome}`)} && `
  }
  // fish accepts the `NAME=value cmd` prefix (3.1+), but not sh's quoting.
  return `CODEX_HOME=${quoteResumeArg(codexHome, platform, shell)} `
}

/** Quotes for the live shell when one is known, else for the platform's default. */
function quoteResumeArg(
  value: string,
  platform: NodeJS.Platform,
  shell?: AgentStartupShell
): string {
  return shell ? quoteStartupArg(value, shell) : quoteShellArg(value, platform)
}

/** Use quoteStartupArg for fish: sh quoting would halve path backslashes and reject a trailing one, with or without an explicit shell. */
function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? quoteCmdDoubleQuoted(value) : quoteStartupArg(value, 'posix')
}
