import { describe, expect, it } from 'vitest'
import {
  buildWslInteractiveLoginShellCommand,
  buildWslLoginShellCommand,
  quotePosixShell
} from './wsl-login-shell-command'

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

  it('starts an interactive login shell without assuming bash', () => {
    const command = buildWslInteractiveLoginShellCommand()

    expect(command).toContain('getent passwd')
    expect(command).toContain('if [ -z "$_orca_wsl_shell" ] || [ ! -x "$_orca_wsl_shell" ]; then')
    expect(command).toContain('exec "$_orca_wsl_shell" -l')
  })
})
