import { describe, expect, it } from 'vitest'
import { shouldOfferDaemonRestart } from './TerminalErrorToast'

describe('shouldOfferDaemonRestart', () => {
  it('matches stale daemon node-pty install failures', () => {
    expect(
      shouldOfferDaemonRestart(
        "Daemon's node-pty install is gone (worktree deleted?). Restart Orca. node-pty: posix_spawn failed: ENOENT (errno 2, No such file or directory) - helper='/Applications/Orca.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper'"
      )
    ).toBe(true)
  })

  it('matches stale daemon cwd failures', () => {
    expect(
      shouldOfferDaemonRestart(
        "Daemon's working directory is gone (worktree deleted?). Restart Orca. node-pty: daemon_cwd failed: ENOENT (errno 2, No such file or directory) - cwd='<unavailable>'"
      )
    ).toBe(true)
  })

  it('does not match unrelated terminal spawn errors', () => {
    expect(shouldOfferDaemonRestart('SSH connection is not active.')).toBe(false)
    expect(shouldOfferDaemonRestart('node-pty: open_slave failed: EMFILE (errno 24)')).toBe(false)
  })
})
