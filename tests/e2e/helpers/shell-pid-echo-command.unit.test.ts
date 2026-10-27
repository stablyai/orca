import { describe, expect, it } from 'vitest'
import { shellPidEchoCommand } from './shell-pid-echo-command'

const MARKER = 'PIDMARK_BEFORE_'
const PRINTED_PID = new RegExp(`${MARKER}(\\d+)`)

describe('shellPidEchoCommand', () => {
  it('reads the pid through $$ in a POSIX shell', () => {
    expect(shellPidEchoCommand(MARKER, 'posix')).toBe(`echo "${MARKER}""$$"`)
  })

  it('reads the pid through $PID in PowerShell, where $$ is the last token', () => {
    const command = shellPidEchoCommand(MARKER, 'powershell')
    expect(command).toContain('$PID')
    expect(command).not.toContain('$$')
  })

  it.each(['posix', 'powershell'] as const)(
    'keeps the typed %s line from matching the printed marker',
    (shell) => {
      expect(PRINTED_PID.test(shellPidEchoCommand(MARKER, shell))).toBe(false)
    }
  )

  it('refuses cmd.exe, which has no pid variable', () => {
    expect(() => shellPidEchoCommand(MARKER, 'cmd')).toThrow('cmd.exe')
  })
})
