import {
  CODEX_KITTY_WINDOW_ID,
  ORCA_IMAGE_PROTOCOL_ENV,
  ORCA_IMAGE_PROTOCOL_VALUE
} from '../../terminal/images/terminal-image-protocol'
import { extractLeadingEnvAssignments } from '../../shell/launch/command-environment'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export const CODEX_EXECUTABLE = /^codex(\.(exe|cmd|bat|ps1))?$/i

const POSIX_PREFIX = `/bin/sh -c ${quoteStartupArg(
  `if [ "$${ORCA_IMAGE_PROTOCOL_ENV}" = ${ORCA_IMAGE_PROTOCOL_VALUE} ] && [ -z "\${KITTY_WINDOW_ID+x}" ]; then export KITTY_WINDOW_ID=${CODEX_KITTY_WINDOW_ID}; fi; exec "$@"`,
  'posix'
)} orca-codex `
const POWERSHELL_PREFIX =
  `& { $orcaKitty = $env:${ORCA_IMAGE_PROTOCOL_ENV} -ceq '${ORCA_IMAGE_PROTOCOL_VALUE}' -and -not (Test-Path Env:KITTY_WINDOW_ID); ` +
  `if ($orcaKitty) { $env:KITTY_WINDOW_ID = '${CODEX_KITTY_WINDOW_ID}' }; try { `
const POWERSHELL_SUFFIX = ' } finally { if ($orcaKitty) { Remove-Item Env:KITTY_WINDOW_ID } } }'

/** Bare Codex uses the interactive shell function. Scope the hint for literal targets that bypass it. */
export function withCodexStartupImageCommand(command: string, shell: AgentStartupShell): string {
  // cmd has no interactive setlocal scope. Keep its existing startup command and quoting.
  if (shell === 'cmd') {
    return command
  }
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok || /[\r\n]/.test(command)) {
    return command
  }
  const firstSpan = parsed.spans[0]
  const first = firstSpan && command.slice(firstSpan.start, firstSpan.end)
  const hasCallOperator =
    shell === 'powershell' ? first === '&' : first === 'command' || first === 'exec'
  const envCommand = shell === 'posix' && first === 'env'
  const index = envCommand
    ? parsed.tokens.length - extractLeadingEnvAssignments(parsed.tokens.slice(1)).rest.length
    : Number(hasCallOperator)
  const executable = parsed.tokens[index]
  if (
    !executable ||
    !CODEX_EXECUTABLE.test(executable.split(/[\\/]/).at(-1) ?? '') ||
    parsed.spans
      .slice(shell === 'powershell' && hasCallOperator ? 1 : 0)
      .some((span) => span.divergesFromShell)
  ) {
    return command
  }
  if (shell === 'powershell') {
    if (executable.toLowerCase() === 'codex' || parsed.tokens.includes('--%')) {
      return command
    }
    return `${POWERSHELL_PREFIX}${command}${POWERSHELL_SUFFIX}`
  }
  if (index === 0 && executable === 'codex') {
    return command
  }
  const start = parsed.spans[index].start
  return `${command.slice(0, start)}${POSIX_PREFIX}${command.slice(start)}`
}

/** Recognize the original startup executable and flags through the generated command. */
export function unwrapCodexStartupImageCommand(command: string): string {
  const trimmed = command.trimStart()
  if (trimmed.startsWith(POSIX_PREFIX)) {
    return trimmed.slice(POSIX_PREFIX.length)
  }
  if (command.startsWith(POWERSHELL_PREFIX) && command.endsWith(POWERSHELL_SUFFIX)) {
    return command.slice(POWERSHELL_PREFIX.length, -POWERSHELL_SUFFIX.length)
  }
  return command
}
