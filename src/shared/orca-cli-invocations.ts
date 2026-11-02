import { COMMAND_TOKEN_SCAN_MAX_CHARS, getCommandTokenPathBasename } from './command-token-scanner'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'

// The published launcher names per platform, plus the dev build's.
const ORCA_CLI_BASENAME = /^orca(?:-dev|-ide)?(?:\.cmd|\.exe)?$/i
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The arguments of each `orca ...` a shell command line runs, in order. Quoted text is an argument, never a command. */
export function orcaCliInvocations(command: string): string[][] {
  const invocations: string[][] = []
  for (const segment of splitUnquotedSegments(command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS))) {
    const tokens = tokenizeCommandLine(segment)
    let index = 0
    while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index])) {
      index += 1
    }
    const binary = tokens[index]
    if (binary !== undefined && ORCA_CLI_BASENAME.test(getCommandTokenPathBasename(binary))) {
      invocations.push(tokens.slice(index + 1))
    }
  }
  return invocations
}

/** Canonical form a child row carries for a worker wait; raw commands outgrow the operation preview. */
export const ORCA_ORCHESTRATION_WAIT_COMMAND = 'orca orchestration check --wait'

/** A command that blocks on `orca orchestration check --wait` is waiting on worker agents, not monitoring. */
export function runsOrcaOrchestrationWait(command: unknown): boolean {
  return (
    typeof command === 'string' &&
    command.includes('orchestration') &&
    orcaCliInvocations(command).some(
      (args) => args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')
    )
  )
}

/** Splits a command line at `&&`, `||`, `;`, `|` and newlines outside quotes. */
function splitUnquotedSegments(commandLine: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]
    if (quote === null && (char === '"' || char === "'")) {
      quote = char
    } else if (quote === char) {
      quote = null
    } else if (quote === null && (char === ';' || char === '|' || char === '&' || char === '\n')) {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}
