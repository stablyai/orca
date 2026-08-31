import { join } from 'node:path'

/**
 * Absolute paths for the Windows system binaries Orca shells out to.
 *
 * Why not a bare name: a bare `powershell.exe` is resolved against the child's
 * PATH, and Orca's PATH under Electron is not the user's. Where a policy has
 * pruned or shadowed the System32 entry the spawn simply fails, and the caller
 * reports the wrong thing — the font picker silently fell back to five
 * hardcoded families rather than saying it could not enumerate (#11771).
 *
 * `SystemRoot` is set on every Windows session; the literal is only a last
 * resort for a stripped environment.
 */
function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows'
}

export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function windowsSystem32Binary(
  fileName: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(systemRoot(env), 'System32', fileName)
}
