import { describe, expect, it } from 'vitest'
import {
  humanizeTerminalError,
  isPaneOwnerUnverifiedError,
  isExplainedTerminalError,
  isSshReconnectOwnedTerminalError,
  shouldOfferDaemonRestart,
  stripSshReconnectOwnedErrorLines
} from './terminal-error-display'
const SSH_FAILURE =
  "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package for linux-x64 not found locally."
const RELAY_LOST =
  "Error invoking remote method 'pty:attach': Error: SSH connection lost, reconnecting..."
const LEGACY_HOST_GONE =
  "Error invoking remote method 'pty:spawn': Error: connect ENOENT \\\\?\\pipe\\orca-terminal-host-v30-14cb7f94b511"

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

  it('matches an IPC-wrapped relay-loss message', () => {
    expect(isSshReconnectOwnedTerminalError(RELAY_LOST)).toBe(true)
    expect(isSshReconnectOwnedTerminalError('SSH connection lost, reconnecting...')).toBe(true)
  })

  it('leaves unrelated terminal errors for the toast', () => {
    expect(isSshReconnectOwnedTerminalError('Paste failed.')).toBe(false)
    expect(isSshReconnectOwnedTerminalError('node-pty: open_slave failed: EMFILE')).toBe(false)
  })
})

describe('humanizeTerminalError', () => {
  it('identifies the owner-unverified safety state', () => {
    expect(isPaneOwnerUnverifiedError('terminal_pane_owner_unverified')).toBe(true)
    expect(isPaneOwnerUnverifiedError('Paste failed.')).toBe(false)
    expect(isPaneOwnerUnverifiedError('Paste failed.\nterminal_pane_owner_unverified')).toBe(false)
  })

  it('humanizes an owner marker without classifying mixed errors as safe warnings', () => {
    const mixed = humanizeTerminalError('Paste failed.\nterminal_pane_owner_unverified')
    expect(mixed).toContain('Paste failed.')

    expect(mixed).not.toContain('terminal_pane_owner_unverified')
    expect(isPaneOwnerUnverifiedError('Paste failed.\nterminal_pane_owner_unverified')).toBe(false)
  })

  it('humanizes every owner marker in an aggregated warning', () => {
    const repeated = humanizeTerminalError(
      "terminal_pane_owner_unverified\nError invoking remote method 'pty:spawn': Error: terminal_pane_owner_unverified"
    )

    expect(repeated).not.toContain('terminal_pane_owner_unverified')
  })

  it('leaves other errors untouched', () => {
    expect(humanizeTerminalError('Paste failed.')).toBe('Paste failed.')
  })

  it("drops Electron's IPC wrapper from a refusal main threw, keeping other lines as they are", () => {
    const wrapped =
      "Error invoking remote method 'runtimeEnvironments:call': Error: Ubuntu was stopped. Start it again."
    expect(humanizeTerminalError(wrapped)).toBe('Ubuntu was stopped. Start it again.')
    expect(humanizeTerminalError(`Paste failed.\n${wrapped}\n  indented detail`)).toBe(
      'Paste failed.\nUbuntu was stopped. Start it again.\n  indented detail'
    )
  })

  it("leaves an SSH host's refusal words and other IPC channels' wrappers as they were", () => {
    expect(
      humanizeTerminalError(
        "Error invoking remote method 'runtimeEnvironments:call': Error: Remote Orca runtime is not connected: ssh desk"
      )
    ).toBe('Remote Orca runtime is not connected: ssh desk')
    const otherChannel = "Error invoking remote method 'ssh:connect': Error: Permission denied"
    expect(humanizeTerminalError(otherChannel)).toBe(otherChannel)
  })

  it('humanizes an IPC-wrapped terminal-host-gone error', () => {
    const prefix = "Error invoking remote method 'pty:spawn': Error: ("
    const humanized = humanizeTerminalError(`${prefix}terminal_host_gone).`)
    expect(humanized).not.toContain('terminal_host_gone')

    expect(humanized).toMatch(/\)\.$/)
  })

  it('humanizes a legacy host raw named-pipe error', () => {
    const humanized = humanizeTerminalError(LEGACY_HOST_GONE)
    expect(humanized).not.toContain('connect ENOENT')
    expect(humanized).not.toContain('orca-terminal-host-v30')
  })

  it('only replaces exact host-gone markers in aggregated errors', () => {
    const humanized = humanizeTerminalError('terminal_host_gone\nterminal_host_gone_extra')

    expect(humanized).toContain('\nterminal_host_gone_extra')
  })

  it('replaces an expired SSH session token and its internal relay id', () => {
    const wrapped =
      "Error invoking remote method 'pty:spawn': Error: SSH_SESSION_EXPIRED: orca:2f1c@@pty-7"
    const humanized = humanizeTerminalError(wrapped)
    expect(humanized).not.toContain('SSH_SESSION_EXPIRED')
    expect(humanized).not.toContain('orca:2f1c@@pty-7')
  })

  it('replaces an expired SSH session token carrying the identity-mismatch marker', () => {
    const humanized = humanizeTerminalError(
      'SSH_SESSION_EXPIRED: orca:2f1c@@pty-7 SSH_PTY_IDENTITY_MISMATCH'
    )
    expect(humanized).not.toContain('SSH_SESSION_EXPIRED')
    expect(humanized).not.toContain('SSH_PTY_IDENTITY_MISMATCH')
  })

  it('replaces a raw relay PTY-not-found string and its quoted id', () => {
    const humanized = humanizeTerminalError(
      'Error invoking remote method \'pty:spawn\': Error: PTY "orca:2f1c@@pty-7" not found'
    )
    expect(humanized).not.toContain('not found')
    expect(humanized).not.toContain('orca:2f1c@@pty-7')
  })

  it('replaces the daemon session-absence string and its id', () => {
    const humanized = humanizeTerminalError(
      "Error invoking remote method 'pty:spawn': SessionNotFoundError: Session not found: wt-1@@pane-a"
    )
    expect(humanized).not.toContain('SessionNotFoundError')
    expect(humanized).not.toContain('wt-1@@pane-a')

    expect(isExplainedTerminalError('Session not found: wt-1@@pane-a')).toBe(true)
  })

  it('replaces the identity-mismatch form of PTY-not-found', () => {
    const humanized = humanizeTerminalError('PTY "orca:2f1c@@pty-7" not found (identity mismatch)')
    expect(humanized).not.toContain('identity mismatch')
    expect(humanized).not.toContain('orca:2f1c@@pty-7')
  })

  it('describes a retired output source as reconnecting, not as a lost session', () => {
    const humanized = humanizeTerminalError(
      'SSH_PTY_SOURCE_RESTORE_REQUIRED: remote:2f1c:pty-7 checkpointUnavailable'
    )
    expect(humanized).not.toContain('SSH_PTY_SOURCE_RESTORE_REQUIRED')
    expect(humanized).not.toContain('remote:2f1c:pty-7')
    expect(humanized).not.toContain('checkpointUnavailable')
  })

  it('replaces only the unreattachable line in an aggregated error', () => {
    const humanized = humanizeTerminalError('Paste failed.\nSSH_SESSION_EXPIRED: orca:2f1c@@pty-7')
    expect(humanized.startsWith('Paste failed.\n')).toBe(true)
    expect(humanized).not.toContain('SSH_SESSION_EXPIRED')
  })

  it.each(['ENOENT', 'ECONNREFUSED'])(
    'does not combine a %s connection failure with a host endpoint on another line',
    (code) => {
      const aggregated =
        `connect ${code} \\\\?\\pipe\\unrelated\n` + 'orca-terminal-host-v30-14cb7f94b511'
      expect(isExplainedTerminalError(aggregated)).toBe(false)
      expect(humanizeTerminalError(aggregated)).toBe(aggregated)
    }
  )
})

describe('isExplainedTerminalError', () => {
  it('suppresses the issue link for a provably dead terminal host', () => {
    expect(isExplainedTerminalError('terminal_host_gone')).toBe(true)
    expect(
      isExplainedTerminalError(
        "Error invoking remote method 'pty:spawn': Error: terminal_host_gone"
      )
    ).toBe(true)
    expect(isExplainedTerminalError(LEGACY_HOST_GONE)).toBe(true)
    expect(
      isExplainedTerminalError('connect ECONNREFUSED /tmp/orca-terminal-host-v30-14cb7f94b511.sock')
    ).toBe(true)
  })

  it('suppresses the issue link while a live session restores its output source', () => {
    expect(
      isExplainedTerminalError(
        'SSH_PTY_SOURCE_RESTORE_REQUIRED: remote:2f1c:pty-7 checkpointUnavailable'
      )
    ).toBe(true)
  })

  it('suppresses the issue link for a session the host cannot reattach', () => {
    expect(isExplainedTerminalError('SSH_SESSION_EXPIRED: orca:2f1c@@pty-7')).toBe(true)
    expect(
      isExplainedTerminalError(
        'Error invoking remote method \'pty:spawn\': Error: PTY "orca:2f1c@@pty-7" not found'
      )
    ).toBe(true)
  })

  it('explains a pane whose saved session another host connection owns, without an issue link', () => {
    const raw = "Error invoking remote method 'pty:spawn': Error: terminal_pane_owner_host_mismatch"
    expect(isExplainedTerminalError(raw)).toBe(true)
    const humanized = humanizeTerminalError(raw)

    expect(humanized).not.toContain('terminal_pane_owner_host_mismatch')
  })

  it('keeps the issue link for errors Orca cannot explain', () => {
    expect(isExplainedTerminalError('Paste failed.')).toBe(false)
    expect(isExplainedTerminalError('node-pty: open_slave failed: EMFILE')).toBe(false)
    expect(isExplainedTerminalError('terminal_gone')).toBe(false)
    expect(isExplainedTerminalError('terminal_host_gone_extra')).toBe(false)
    expect(isExplainedTerminalError('aterminal_host_gone.')).toBe(false)
    expect(isExplainedTerminalError('0terminal_host_gone.')).toBe(false)
    expect(isExplainedTerminalError('_terminal_host_gone.')).toBe(false)
    expect(isExplainedTerminalError('open ENOENT \\\\?\\pipe\\orca-terminal-host-v30-dead')).toBe(
      false
    )
    expect(
      isExplainedTerminalError('connect ETIMEDOUT \\\\?\\pipe\\orca-terminal-host-v30-dead')
    ).toBe(false)
    expect(isExplainedTerminalError('connect ENOENT \\\\?\\pipe\\unrelated')).toBe(false)
  })
})

describe('stripSshReconnectOwnedErrorLines', () => {
  it('clears an error that is only SSH reconnect text', () => {
    expect(stripSshReconnectOwnedErrorLines(SSH_FAILURE)).toBeNull()
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
