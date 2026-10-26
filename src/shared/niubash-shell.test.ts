import { describe, expect, it } from 'vitest'
import { isNiubashShell } from './niubash-shell'
import {
  canonicalizeWindowsShellOverride,
  resolveWindowsShellStartupFamily,
  resolveLocalWindowsAgentStartupShell
} from './windows-terminal-shell'
import { isShellProcess } from './shell-process-detection'
import { TerminalCreateParams } from './rpc-contract/terminal-unary-params'
import { resolveSetupRunnerCommand } from './setup-runner-command'

describe('Niubash shell contracts', () => {
  it.each(['niu', 'NIU.EXE', 'C:\\Niu Shell\\niu.exe', '/usr/local/bin/niu'])(
    'recognizes %s as a shell, not an agent',
    (shell) => {
      expect(isNiubashShell(shell)).toBe(true)
      expect(isShellProcess(shell)).toBe(true)
      expect(resolveWindowsShellStartupFamily(shell)).toBe('posix')
    }
  )

  it('does not confuse Nushell or similarly named programs with niu', () => {
    expect(isNiubashShell('nu.exe')).toBe(false)
    expect(isNiubashShell('niubash-agent')).toBe(false)
  })

  it.each(['niu', 'niu.exe', 'NIU.EXE'])(
    'accepts and canonicalizes %s over the terminal RPC boundary',
    (shell) => {
      expect(canonicalizeWindowsShellOverride(shell)).toBe('niu.exe')
      expect(TerminalCreateParams.parse({ worktree: 'path:D:/folder', shell }).shell).toBe(
        'niu.exe'
      )
    }
  )

  it('does not leak a local niu shell selection into SSH command quoting', () => {
    expect(
      resolveLocalWindowsAgentStartupShell({
        platform: 'win32',
        isRemote: true,
        terminalWindowsShell: 'niu.exe'
      })
    ).toBeUndefined()
  })

  it('executes shell runners with niu and native paths, including spaces and apostrophes', () => {
    expect(
      resolveSetupRunnerCommand("D:\\project's folder\\setup.sh", 'windows', {
        family: 'posix',
        executable: 'C:\\Niu Shell\\niu.exe'
      })
    ).toEqual({
      command: "'C:/Niu Shell/niu.exe' 'D:/project'\\''s folder/setup.sh'",
      runnerScriptPathForShell: "D:/project's folder/setup.sh",
      shell: 'posix'
    })
    const batch = resolveSetupRunnerCommand('D:\\repo\\setup.cmd', 'windows', {
      family: 'posix',
      executable: 'niu.exe'
    })
    expect(batch.shell).toBe('windows')
    expect(batch.command).not.toMatch(/^niu/)
  })
})
