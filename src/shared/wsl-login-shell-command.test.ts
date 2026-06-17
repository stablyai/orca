import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import {
  buildWslInteractiveLoginShellCommand,
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from './wsl-login-shell-command'

function expectValidShSyntax(command: string): void {
  try {
    execFileSync('sh', ['-n'], { input: command })
    return
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    ) {
      throw error
    }
  }
  execFileSync('wsl.exe', ['--', 'sh', '-n'], { input: command })
}

describe('wsl login shell command helpers', () => {
  it('quotes single quotes for POSIX shell arguments', () => {
    expect(quotePosixShell("a'b")).toBe("'a'\\''b'")
  })

  it('runs commands through the distro user login shell', () => {
    const command = buildWslLoginShellCommand("printf 'hello'")

    expect(command).toContain('getent passwd')
    expect(command).toContain('exec "$_orca_wsl_shell" -ilc')
    expect(command).toContain("printf '\\''hello'\\''")
  })

  it('preserves command-scoped environment variables through the outer WSL shell', () => {
    const command = buildWslLoginShellCommand('HISTFILE=/tmp/orca-history printf "$HISTFILE"')
    const escaped = escapeWslShCommandForWindows(command)

    expect(command).toContain('\'HISTFILE=/tmp/orca-history printf "$HISTFILE"\'')
    expect(escaped).toContain('\\$_orca_wsl_shell')
    expect(escaped).toContain('\\${SHELL:-/bin/bash}')
    expect(escaped).toContain('\\$(getent passwd "\\$(id -un)"')
    expect(escaped).toContain('\\$HISTFILE')
    expectValidShSyntax(command)
  }, 15_000)

  it('does not double-escape wrapper shell variables', () => {
    const command = 'echo \\$_orca_wsl_shell "$_orca_wsl_shell"'

    expect(escapeWslShCommandForWindows(command)).toBe(
      'echo \\$_orca_wsl_shell "\\$_orca_wsl_shell"'
    )
  })

  it('escapes user command dollars inside POSIX-quoted payloads for WSL argv', () => {
    const command = buildWslLoginShellCommand(
      'HISTFILE=/tmp/orca-history printf "$HISTFILE"; printf \'%s\' "$SHELL"'
    )
    const escaped = escapeWslShCommandForWindows(command)

    expect(escaped).toContain(
      "'HISTFILE=/tmp/orca-history printf \"\\$HISTFILE\"; printf '\\''%s'\\'' \"\\$SHELL\"'"
    )
    expectValidShSyntax(command)
  }, 15_000)

  it('preserves user command variables across the Windows-to-WSL argv boundary', () => {
    if (process.platform !== 'win32') {
      return
    }
    try {
      execFileSync('wsl.exe', ['--', 'true'])
    } catch {
      return
    }

    const command = buildWslLoginShellCommand('orca_value=ok; printf "<%s>" "$orca_value"')
    const escaped = escapeWslShCommandForWindows(command)

    expect(execFileSync('wsl.exe', ['--', 'sh', '-lc', escaped], { encoding: 'utf8' })).toBe('<ok>')
  }, 15_000)

  it('starts an interactive login shell without assuming bash', () => {
    const command = buildWslInteractiveLoginShellCommand()

    expect(command).toContain('getent passwd')
    expect(command).toContain('if [ -z "$_orca_wsl_shell" ] || [ ! -x "$_orca_wsl_shell" ]; then')
    expect(command).toContain('exec "$_orca_wsl_shell" -l')
  })
})
