import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export function getWindowsPowerShellShimSpawn(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { spawnCmd: string; spawnArgs: string[] } | null {
  if (!win32.isAbsolute(command)) {
    return null
  }
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
      // Why: npm/agent .ps1 shims on user systems are unsigned; Bypass is scoped strictly to -File.
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      powerShellShim,
      ...args
    ]
  }
}
