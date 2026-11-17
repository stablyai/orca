import { randomUUID } from 'node:crypto'

/** Use the executing shell, never the desktop platform; unknown/unsupported shells keep their input unchanged.
 * Opt-in for Orca-built foreground invocations that do not read the previous interactive status. */
export function identifyTerminalCommand(
  command: string,
  shell: string | undefined
): {
  command: string
  commandId?: string
} {
  const name = shell
    ?.split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, '')
  if (name !== 'bash' && name !== 'zsh' && name !== 'powershell' && name !== 'pwsh') {
    return { command }
  }
  const commandId = randomUUID().replaceAll('-', '')
  const bind =
    name === 'powershell' || name === 'pwsh'
      ? `if (Test-Path function:__OrcaBindCommand) { & (Get-Item function:__OrcaBindCommand) '${commandId}' }; `
      : `if builtin typeset -f __orca_osc133_bind_command >/dev/null 2>&1; then \\__orca_osc133_bind_command '${commandId}'; fi; `
  return { command: bind + command, commandId }
}
