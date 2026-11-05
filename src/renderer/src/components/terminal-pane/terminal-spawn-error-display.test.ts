import { describe, expect, it } from 'vitest'

import { failedSpawnShell } from './terminal-spawn-error-display'

const RAW =
  'Failed to spawn shell "/bin/zsh": node-pty: open_slave failed: EMFILE (errno 24, Too many open files) (shell: /bin/zsh). If this persists, please file an issue.'

describe('failedSpawnShell', () => {
  it('reads the shell from daemon and local spawn failures', () => {
    expect(
      failedSpawnShell(
        'Daemon failed to spawn shell "C:\\Windows\\System32\\wsl.exe" with cwd "C:\\"'
      )
    ).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(failedSpawnShell(RAW)).toBe('/bin/zsh')
    expect(failedSpawnShell('Paste failed.')).toBeNull()
  })
})
