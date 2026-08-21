// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const environmentMocks = vi.hoisted(() => ({
  resolveFooter: vi.fn()
}))

vi.mock('@/lib/client-environment-info', () => ({
  resolveClientEnvironmentFooter: environmentMocks.resolveFooter
}))

import {
  TerminalErrorToast,
  humanizeTerminalError,
  isExplainedTerminalError,
  isSshReconnectOwnedTerminalError,
  shouldOfferDaemonRestart,
  stripSshReconnectOwnedErrorLines
} from './TerminalErrorToast'

beforeEach(() => {
  environmentMocks.resolveFooter.mockReset()
  environmentMocks.resolveFooter.mockResolvedValue(
    ['---', 'Orca: 1.4.178-rc.2', 'OS: darwin 25.0.0 (arm64)', 'Shell: /bin/zsh'].join('\n')
  )
})

afterEach(() => {
  cleanup()
})

const SSH_FAILURE =
  "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package for linux-x64 not found locally."
// Relay loss reaches reportError already IPC-wrapped, so the marker is mid-string.
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
  it('replaces the pane-owner-unverified code with actionable copy', () => {
    const humanized = humanizeTerminalError('terminal_pane_owner_unverified')
    expect(humanized).not.toContain('terminal_pane_owner_unverified')
    expect(humanized).toContain('Reopen this pane to retry')
  })

  it('humanizes an IPC-wrapped pane-owner-unverified error', () => {
    const wrapped =
      "Error invoking remote method 'pty:spawn': Error: terminal_pane_owner_unverified"
    expect(humanizeTerminalError(wrapped)).not.toContain('terminal_pane_owner_unverified')
  })

  it('leaves other errors untouched', () => {
    expect(humanizeTerminalError('Paste failed.')).toBe('Paste failed.')
  })

  it('replaces the terminal-host-gone code with copy that explains the loss', () => {
    const humanized = humanizeTerminalError('terminal_host_gone')
    expect(humanized).not.toContain('terminal_host_gone')
    expect(humanized).toContain('Open a new terminal to continue')
  })

  it('humanizes an IPC-wrapped terminal-host-gone error', () => {
    const prefix = "Error invoking remote method 'pty:spawn': Error: ("
    const humanized = humanizeTerminalError(`${prefix}terminal_host_gone).`)
    expect(humanized).not.toContain('terminal_host_gone')
    expect(humanized).toContain(`${prefix}The terminal daemon`)
    expect(humanized).toMatch(/\)\.$/)
  })

  it('humanizes a legacy host raw named-pipe error', () => {
    const humanized = humanizeTerminalError(LEGACY_HOST_GONE)
    expect(humanized).not.toContain('connect ENOENT')
    expect(humanized).not.toContain('orca-terminal-host-v30')
    expect(humanized).toContain('Open a new terminal to continue')
  })

  it('only replaces exact host-gone markers in aggregated errors', () => {
    const humanized = humanizeTerminalError('terminal_host_gone\nterminal_host_gone_extra')
    expect(humanized).toContain('Open a new terminal to continue')
    expect(humanized).toContain('\nterminal_host_gone_extra')
  })

  it('replaces an expired SSH session token and its internal relay id', () => {
    const wrapped =
      "Error invoking remote method 'pty:spawn': Error: SSH_SESSION_EXPIRED: orca:2f1c@@pty-7"
    const humanized = humanizeTerminalError(wrapped)
    expect(humanized).not.toContain('SSH_SESSION_EXPIRED')
    expect(humanized).not.toContain('orca:2f1c@@pty-7')
    expect(humanized).toContain('Open a new terminal to continue')
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
    expect(humanized).toContain('Open a new terminal to continue')
  })

  it('replaces the identity-mismatch form of PTY-not-found', () => {
    const humanized = humanizeTerminalError('PTY "orca:2f1c@@pty-7" not found (identity mismatch)')
    expect(humanized).not.toContain('identity mismatch')
    expect(humanized).not.toContain('orca:2f1c@@pty-7')
  })

  // Why: "no such session" from the relay is not proof the remote shell died, so the copy must not claim either.
  it('does not claim the remote shell is still running or dead', () => {
    const humanized = humanizeTerminalError('SSH_SESSION_EXPIRED: orca:2f1c@@pty-7')
    expect(humanized).not.toContain('may still be running')
    expect(humanized).not.toContain('exited')
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

  it('suppresses the issue link for a session the host cannot reattach', () => {
    expect(isExplainedTerminalError('SSH_SESSION_EXPIRED: orca:2f1c@@pty-7')).toBe(true)
    expect(
      isExplainedTerminalError(
        'Error invoking remote method \'pty:spawn\': Error: PTY "orca:2f1c@@pty-7" not found'
      )
    ).toBe(true)
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

  it('drops an IPC-wrapped relay-loss line and keeps the rest', () => {
    expect(stripSshReconnectOwnedErrorLines(RELAY_LOST)).toBeNull()
    expect(stripSshReconnectOwnedErrorLines(`Paste failed.\n${RELAY_LOST}`)).toBe('Paste failed.')
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

describe('TerminalErrorToast environment footer', () => {
  it('appends client environment details to local errors', async () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: 'Paste failed.',
        onDismiss: vi.fn()
      })
    )

    await waitFor(() => expect(view.container.textContent).toContain('Orca: 1.4.178-rc.2'))
  })

  it('does not retain a prior async footer when the next error already has one', async () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: 'First failure.',
        onDismiss: vi.fn()
      })
    )
    await waitFor(() => expect(view.container.textContent).toContain('Orca: 1.4.178-rc.2'))

    view.rerender(
      React.createElement(TerminalErrorToast, {
        error: 'Second failure.\n\n---\nOrca: embedded\nOS: linux 6.8 (x64)',
        onDismiss: vi.fn()
      })
    )

    expect(view.container.textContent).toContain('Orca: embedded')
    expect(view.container.textContent).not.toContain('Orca: 1.4.178-rc.2')
  })

  it('omits client details for every SSH reconnect-owned error', async () => {
    render(
      React.createElement(TerminalErrorToast, {
        error: SSH_FAILURE,
        onDismiss: vi.fn()
      })
    )

    await waitFor(() => expect(environmentMocks.resolveFooter).not.toHaveBeenCalled())
  })
})
