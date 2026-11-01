import { describe, expect, it } from 'vitest'
import { shellPidEchoCommand } from './shell-pid-echo-command'

const MARKER = 'PIDMARK_BEFORE_'
const PRINTED_PID = new RegExp(`${MARKER}(\\d+)`)

describe('shellPidEchoCommand', () => {
  it('reads the pid as a child sh sees its parent, so fish works as well as bash and zsh', () => {
    expect(shellPidEchoCommand(MARKER, 'posix')).toBe(`sh -c 'echo "${MARKER}$PPID"'`)
  })

  it('reads the pid through $PID in PowerShell, where $$ is the last token', () => {
    // Inside the single-quoted marker PowerShell would print '$PID' literally.
    expect(shellPidEchoCommand(MARKER, 'powershell')).toBe(`echo ('${MARKER}' + $PID)`)
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
