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

// Why: cmd.exe re-parses the command line, and these are the characters that can
// start a new command or expand a variable out of an otherwise inert argument.
// `(`/`)` are deliberately absent: they only group commands, and grouping cannot
// chain anything without one of the separators below, so rejecting them merely
// broke every `C:\Program Files (x86)\...` shim and paren-bearing worktree path.
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
  /**
   * GUI launchers (Open In apps) should not leave a lingering Command Prompt.
   * `start "" /B` returns immediately and keeps console-subsystem children of
   * `.cmd`/`.bat` shims from allocating a fresh visible prompt window.
   *
   * Opt-in only: `start` re-parses the command line, so callers whose argv can
   * carry quoted operands (VS Code `--remote` authorities and remote paths with
   * spaces) must leave this off.
   */
  detachedGui?: boolean
}

export function getSpawnArgsForWindows(
  command: string,
  args: string[],
  options: GetSpawnArgsForWindowsOptions = {}
): { spawnCmd: string; spawnArgs: string[] } {
  if (isWindowsBatchScript(command)) {
    assertWindowsCmdSafeTokens([command, ...args])

    // Why: separate argv entries let Node quote spaces without breaking cmd.
    if (options.detachedGui) {
      // Why: `start` launches a batch target through a nested `cmd /K`, which
      // stays resident after the script ends — `/B` only suppresses a *new*
      // console, so the shim leaks a hidden cmd.exe. Handing `start` an inner
      // `cmd /d /c` makes that interpreter exit with the script.
      //
      // Window title must be an *empty argv entry* (`''`). libuv's Windows
      // quoter turns empty into `""` on the CreateProcess command line — the
      // empty title `start` requires so a later quoted path is not eaten as
      // the title. The two-character string `'""'` is wrong: libuv re-escapes
      // it to `"\"\""`. (Default ComSpec has no spaces, so the bad form often
      // still "works"; quoted Program Files paths are where it breaks.)
      const cmdExePath = getCmdExePath()
      return {
        spawnCmd: cmdExePath,
        spawnArgs: ['/d', '/c', 'start', '', '/B', cmdExePath, '/d', '/c', command, ...args]
      }
    }
    return { spawnCmd: getCmdExePath(), spawnArgs: ['/d', '/c', command, ...args] }
  }
  return { spawnCmd: command, spawnArgs: args }
}

/**
 * Inverse of `detachedGui`'s `start "" /B`: a visible console that waits.
 * Title is the empty argv entry so libuv emits `""` rather than `"\"\""`.
 */
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
