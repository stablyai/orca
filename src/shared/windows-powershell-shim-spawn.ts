import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export function getWindowsPowerShellShimSpawn(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { spawnCmd: string; spawnArgs: string[] } | null {
  const powerShellShim = command.replace(/\.(cmd|bat)$/i, '.ps1')
  if (powerShellShim === command || !existsSync(powerShellShim)) {
    return null
  }
  const configuredRoot = env.SystemRoot ?? env.WINDIR
  const systemRoot =
    configuredRoot && /^[a-z]:[\\/]/i.test(configuredRoot) ? configuredRoot : 'C:\\Windows'
  return {
    spawnCmd: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    spawnArgs: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      powerShellShim,
      ...args
    ]
  }
}
