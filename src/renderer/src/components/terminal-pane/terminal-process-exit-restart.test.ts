import { describe, expect, it } from 'vitest'
import { resolveTerminalProcessExitRestartStartup } from './terminal-process-exit-restart'

describe('terminal process exit restart', () => {
  it('retries the original startup after a Git Bash capacity failure', () => {
    const startup = { command: 'codex --resume session-1' }

    expect(
      resolveTerminalProcessExitRestartStartup({
        paneId: 1,
        exitCode: 1,
        reason: 'git-bash-console-capacity',
        startup
      })
    ).toBe(startup)
  })

  it('restarts a shell when a capacity failure had no startup request', () => {
    expect(
      resolveTerminalProcessExitRestartStartup({
        paneId: 1,
        exitCode: 1,
        reason: 'git-bash-console-capacity',
        startup: null
      })
    ).toBeNull()
  })

  it('restarts other process failures as a shell', () => {
    expect(
      resolveTerminalProcessExitRestartStartup({
        paneId: 1,
        exitCode: 7,
        reason: 'process-failed',
        startup: { command: 'codex' }
      })
    ).toBeNull()
  })
})
