import { describe, expect, it } from 'vitest'
import {
  isSshReconnectOwnedTerminalError,
  shouldOfferDaemonRestart,
  stripSshReconnectOwnedErrorLines
} from './TerminalErrorToast'

const SSH_FAILURE =
  "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package for linux-x64 not found locally."

describe('isSshReconnectOwnedTerminalError', () => {
  it('matches raw ssh:connect failures and inactive-host messages', () => {
    expect(
      isSshReconnectOwnedTerminalError(
        "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package for linux-x64 not found locally."
      )
    ).toBe(true)
    expect(
      isSshReconnectOwnedTerminalError(
        'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
      )
    ).toBe(true)
  })

  it('leaves unrelated terminal errors for the toast', () => {
    expect(isSshReconnectOwnedTerminalError('Paste failed.')).toBe(false)
    expect(isSshReconnectOwnedTerminalError('node-pty: open_slave failed: EMFILE')).toBe(false)
  })
})

describe('stripSshReconnectOwnedErrorLines', () => {
  it('clears an error that is only SSH reconnect text', () => {
    expect(stripSshReconnectOwnedErrorLines(SSH_FAILURE)).toBeNull()
  })

  it('keeps an unrelated error that precedes the SSH failure', () => {
    expect(stripSshReconnectOwnedErrorLines(`Paste failed.\n${SSH_FAILURE}`)).toBe('Paste failed.')
  })

  it('keeps an unrelated error that follows the SSH failure', () => {
    expect(stripSshReconnectOwnedErrorLines(`${SSH_FAILURE}\nPaste failed.`)).toBe('Paste failed.')
  })

  it('drops every SSH-owned line but preserves the rest', () => {
    expect(
      stripSshReconnectOwnedErrorLines(
        `${SSH_FAILURE}\nPaste failed.\nSSH connection is not active. Use the reconnect dialog.`
      )
    ).toBe('Paste failed.')
  })

  it('leaves an error with no SSH text untouched', () => {
    expect(stripSshReconnectOwnedErrorLines('Paste failed.')).toBe('Paste failed.')
  })
})

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
