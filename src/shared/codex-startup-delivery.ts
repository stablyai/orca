import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { shellReadyMarkerComesFromLineEditor } from './shell-ready-marker-timing'

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
  const tokens = tokenizeCommandWithQuoteMetadata(command)
  return tokens.some(
    (token, index) =>
      index > 0 &&
      !token.startsQuoted &&
      (token.value === '--prefill' || token.value.startsWith('--prefill='))
  )
}

export function isCodexStartupCommand(command: string | null | undefined): boolean {
  return recognizeAgentProcessFromCommandLine(command)?.agent === 'codex'
}

export function shouldUseShellReadyStartupDelivery(args: {
  command: string | null | undefined
  startupCommandDelivery?: StartupCommandDelivery
  /** The shell that will run the command, when the deciding side knows it. Plain Codex
   *  waits for the handshake on shells that publish the marker from their line editor:
   *  there the wait ends at the prompt, while an early write double-echoes the launch. */
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
