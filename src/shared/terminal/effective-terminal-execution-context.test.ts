import { expect, it } from 'vitest'
import { selectEffectiveTerminalExecutionContext } from './effective-terminal-execution-context'

it.each([
  ['win32', 'C:\\plain', 'powershell.exe', 'Ubuntu', undefined, 'native', undefined],
  ['win32', 'C:\\plain', 'cmd.exe', 'Ubuntu', undefined, 'native', undefined],
  ['win32', 'C:\\plain', 'git-bash', 'Ubuntu', undefined, 'native', undefined],
  ['win32', 'C:\\plain', 'wsl.exe', undefined, 'Ubuntu', 'wsl', 'Ubuntu'],
  ['win32', 'C:\\plain', 'wsl.exe', 'Debian', 'Ubuntu', 'wsl', 'Debian'],
  ['win32', 'C:\\plain', 'wsl.exe', undefined, undefined, 'unresolved-wsl', undefined],
  [
    'win32',
    '\\\\wsl.localhost\\Ubuntu\\home\\me',
    'powershell.exe',
    'Debian',
    undefined,
    'wsl',
    'Ubuntu'
  ],
  ['darwin', '/plain', 'wsl.exe', 'Ubuntu', 'Ubuntu', 'native', undefined],
  ['linux', '/plain', 'wsl.exe', 'Ubuntu', 'Ubuntu', 'native', undefined]
] as const)(
  'selects %s %s %s without treating a distro hint as execution',
  (platform, cwd, shell, preferredDistro, defaultDistro, kind, distro) => {
    expect(
      selectEffectiveTerminalExecutionContext({
        platform,
        cwd,
        shell,
        preferredDistro,
        defaultDistro
      })
    ).toEqual(distro ? { kind: 'wsl', context: { distro, treatPosixCwdAsWsl: true } } : { kind })
  }
)

it('retains the PTY worktree identity over a native cwd and shell', () => {
  expect(
    selectEffectiveTerminalExecutionContext({
      platform: 'win32',
      cwd: 'C:\\plain',
      shell: 'powershell.exe',
      preferredDistro: 'Debian',
      worktreeContext: { distro: 'Ubuntu', treatPosixCwdAsWsl: true }
    })
  ).toEqual({ kind: 'wsl', context: { distro: 'Ubuntu', treatPosixCwdAsWsl: true } })
})
