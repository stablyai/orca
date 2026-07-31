import { win32 } from 'node:path'

/** Full path to cmd.exe for GUI and service-launched processes. */
export function getCmdExePath(): string {
  return (
    process.env.ComSpec ||
    win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  )
}

export function isWindowsBatchScript(commandPath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath)
}

export const WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR = 'UNSAFE_WINDOWS_BATCH_ARGUMENTS'

export class UnsafeWindowsBatchArgumentsError extends Error {
  constructor() {
    super(WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR)
    this.name = 'UnsafeWindowsBatchArgumentsError'
  }
}

function hasUnsafeWindowsBatchSyntax(value: string): boolean {
  return /[&|<>^"%!()\r\n]/.test(value)
}

export function getSpawnArgsForWindows(
  command: string,
  args: string[]
): { spawnCmd: string; spawnArgs: string[] } {
  if (isWindowsBatchScript(command)) {
    for (const value of [command, ...args]) {
      if (hasUnsafeWindowsBatchSyntax(value)) {
        throw new UnsafeWindowsBatchArgumentsError()
      }
    }

    // Why: separate argv entries let Node quote spaces without breaking cmd.
    return { spawnCmd: getCmdExePath(), spawnArgs: ['/d', '/c', command, ...args] }
  }
  return { spawnCmd: command, spawnArgs: args }
}
