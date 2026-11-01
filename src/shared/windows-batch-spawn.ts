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

// Reject cmd chaining/expansion characters. Parentheses only group here, so allow them for Program Files (x86) and workspace paths.
const WINDOWS_BATCH_UNSAFE_CHARACTERS = ['&', '|', '<', '>', '^', '"', '%', '!'] as const

/** The rejected characters, spelled for error messages so they cannot drift from the guard. */
export const WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL = WINDOWS_BATCH_UNSAFE_CHARACTERS.join(' ')

const UNSAFE_WINDOWS_BATCH_SYNTAX = new RegExp(
  `[${WINDOWS_BATCH_UNSAFE_CHARACTERS.map((character) => character.replace(/[\\^\]-]/, '\\$&')).join('')}\\r\\n]`
)

function hasUnsafeWindowsBatchSyntax(value: string): boolean {
  return UNSAFE_WINDOWS_BATCH_SYNTAX.test(value)
}

function assertWindowsCmdSafeTokens(values: readonly string[]): void {
  if (values.some(hasUnsafeWindowsBatchSyntax)) {
    throw new UnsafeWindowsBatchArgumentsError()
  }
}

export type GetSpawnArgsForWindowsOptions = {
  /** Opt-in GUI launch: start empty-title /B avoids a visible prompt but reparses argv, so callers with quoted operands (such as VS Code remote paths) must leave it off. */
  detachedGui?: boolean
}

export function getSpawnArgsForWindows(
  command: string,
  args: string[],
  options: GetSpawnArgsForWindowsOptions = {}
): { spawnCmd: string; spawnArgs: string[] } {
  if (isWindowsBatchScript(command)) {
    assertWindowsCmdSafeTokens([command, ...args])

    // cmd /c strips the outer quotes of a line starting with one, splitting spaced launchers; `@` avoids that without `call`'s /? and exit-code changes.
    const batchInvocation = ['@', command, ...args]
    if (options.detachedGui) {
      // start normally nests cmd /K and leaks a hidden interpreter; explicitly use cmd /d /c to exit with the shim.
      // Pass an empty argv entry for the title: libuv emits the required double quotes. A literal quote-pair is re-escaped and breaks spaced paths.
      const cmdExePath = getCmdExePath()
      return {
        spawnCmd: cmdExePath,
        spawnArgs: ['/d', '/c', 'start', '', '/B', cmdExePath, '/d', '/c', ...batchInvocation]
      }
    }
    return { spawnCmd: getCmdExePath(), spawnArgs: ['/d', '/c', ...batchInvocation] }
  }
  return { spawnCmd: command, spawnArgs: args }
}

/** Visible start /WAIT counterpart; an empty title argument lets libuv emit the required quotes. */
export function wrapWindowsStartWait(
  spawnCmd: string,
  spawnArgs: string[]
): { spawnCmd: string; spawnArgs: string[] } {
  // Why: `start` reparses every target through cmd.exe, including .exe paths.
  assertWindowsCmdSafeTokens([spawnCmd, ...spawnArgs])
  const cmdExePath = getCmdExePath()
  return {
    spawnCmd: cmdExePath,
    spawnArgs: ['/d', '/c', 'start', '', '/wait', spawnCmd, ...spawnArgs]
  }
}
