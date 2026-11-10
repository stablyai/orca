import { expect, it } from 'vitest'
import { selectEffectiveTerminalExecutionContext } from './effective-terminal-execution-context'

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
