import { launchExecutableIs, readLaunchArguments, readLaunchPosition } from './launch-position'
import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from '../catalog/tui-agent'
import { recognizeAgentProcessFromCommandLine } from '../../agent-status/process/agent-process-recognition'
import { shellReadyMarkerComesFromLineEditor } from '../../terminal/output/shell-ready-marker-timing'
import { unwrapPowerShellNativeLaunch } from './powershell-native-launch'
import { CODEX_EXECUTABLE, unwrapDirectAgentLaunchCommand } from './direct-agent-launch-recognition'

export type StartupCommandDelivery = 'fast' | 'shell-ready'

type CommandToken = {
  value: string
  startsQuoted: boolean
}

function tokenizeCommandWithQuoteMetadata(command: string): CommandToken[] {
  const tokens: CommandToken[] = []
  let current = ''
  let inToken = false
  let startsQuoted = false
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      const next = command[index + 1]
      if (next && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
        escaped = true
        inToken = true
        continue
      }
    }
    if ((char === '"' || char === "'") && quote === null) {
      if (!inToken) {
        startsQuoted = true
      }
      quote = char
      inToken = true
      continue
    }
    if (quote === char) {
      quote = null
      continue
    }
    if (/\s/.test(char) && quote === null) {
      if (inToken) {
        tokens.push({ value: current, startsQuoted })
        current = ''
        inToken = false
        startsQuoted = false
      }
      continue
    }
    current += char
    inToken = true
  }

  if (inToken) {
    tokens.push({ value: current, startsQuoted })
  }
  return tokens
}

export function hasCodexNativeDraftFlag(command: string | null | undefined): boolean {
  if (recognizeAgentProcessFromCommandLine(command)?.agent !== 'codex' || !command) {
    return false
  }
  const unwrapped = unwrapDirectAgentLaunchCommand(command)
  const wasNativePowerShellLaunch = unwrapPowerShellNativeLaunch(command) !== command
  const tokens = tokenizeCommandWithQuoteMetadata(unwrapped)
  return tokens.some(
    (token, index) =>
      index > 0 &&
      (!token.startsQuoted || wasNativePowerShellLaunch) &&
      (token.value === '--prefill' || token.value.startsWith('--prefill='))
  )
}

export function isCodexStartupCommand(command: string | null | undefined): boolean {
  return recognizeAgentProcessFromCommandLine(command)?.agent === 'codex'
}

export function shouldUseShellReadyStartupDelivery(args: {
  command: string | null | undefined
  startupCommandDelivery?: StartupCommandDelivery
  /** Plain Codex waits for line-editor handshake markers to avoid an early launch write echoing twice; use the deciding side’s shell when known. */
  shellPath?: string
}): boolean {
  return (
    args.startupCommandDelivery === 'shell-ready' ||
    hasCodexNativeDraftFlag(args.command) ||
    (args.shellPath !== undefined &&
      shellReadyMarkerComesFromLineEditor(args.shellPath) &&
      isCodexStartupCommand(args.command))
  )
}

// Why not win32: Codex there reads console input records and needs its burst for pastes (windowsInputRecordPasteNewline).
// Elsewhere Orca's terminals bracket every paste, so the burst can only misread relayed typing (#34496).
function agentTerminalInputArgs(
  agent: TuiAgent,
  platform: NodeJS.Platform | null
): readonly string[] {
  return agent === 'codex' && platform !== null && platform !== 'win32'
    ? ['-c', 'disable_paste_burst=true']
    : []
}

/** Appends the per-launch terminal input flags to a recorded agent command. */
export function withAgentTerminalInputArgs(
  command: string,
  agent: TuiAgent,
  /** OS that runs the agent; null when the host has not reported it. */
  platform: NodeJS.Platform | null,
  shell: AgentStartupShell
): string {
  const inputArgs = agentTerminalInputArgs(agent, platform)
  if (!inputArgs.length) {
    return command
  }
  const launch = readLaunchPosition(command, shell)
  if (!launch || !launchExecutableIs(launch.executable, CODEX_EXECUTABLE)) {
    return command
  }
  const argv = readLaunchArguments(command, shell, launch)
  return argv && !command.includes('disable_paste_burst') && !argv.includes('--')
    ? `${command} ${inputArgs.map((arg) => quoteStartupArg(arg, shell)).join(' ')}`
    : command
}
