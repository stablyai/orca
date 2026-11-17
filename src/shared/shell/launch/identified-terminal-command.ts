import { randomUUID } from 'node:crypto'

/** Opt-in for Orca-built foreground invocations that do not read the previous interactive status. */
export function identifyTerminalCommand(command: string, shell: 'posix' | 'powershell'): {
  command: string
  commandId: string
} {
  const commandId = randomUUID().replaceAll('-', '')
  const bind =
    shell === 'powershell'
      ? `if (Test-Path function:__OrcaBindCommand) { __OrcaBindCommand '${commandId}' }; `
      : `if builtin typeset -f __orca_bind_command >/dev/null 2>&1; then \\__orca_bind_command '${commandId}'; fi; `
  return { command: bind + command, commandId }
}
