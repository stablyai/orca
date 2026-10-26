// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const environmentMocks = vi.hoisted(() => ({
  resolveFooter: vi.fn()
}))

vi.mock('@/lib/client-environment-info', () => ({
  resolveClientEnvironmentFooter: environmentMocks.resolveFooter
}))

import { i18n } from '@/i18n/i18n'
import { appendPaneTerminalError, terminalErrorForPane } from './terminal-error-accumulation'

import {
  TerminalErrorToast,
  humanizeTerminalError,
  isPaneOwnerUnverifiedError,
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
  it('bounds startup row work linearly through accumulated toast renders at N and 10N', () => {
    const tokenMatches = vi.spyOn(String.prototype, 'match')
    const translations = vi.spyOn(i18n, 't')
    try {
      for (const kind of ['startup', 'mixed', 'unmatched'] as const) {
        let view: ReturnType<typeof render> | undefined
        for (const rowCount of [2, 20]) {
          const rows = Array.from({ length: rowCount }, (_, index) =>
            kind === 'startup' || (kind === 'mixed' && index % 2 === 0)
              ? `Attempt ${index}: agent_session_exited_during_start`
              : `Paste failed ${index}.`
          )
          const midpoint = rowCount / 2
          const errors = appendPaneTerminalError(
            appendPaneTerminalError({}, 1, rows.slice(0, midpoint).join('\n')),
            1,
            rows.slice(midpoint).join('\n')
          )
          const error = terminalErrorForPane(null, errors, 1)
          expect(error).toBe(rows.join('\n'))
          if (error === null) {
            throw new Error('Accumulated error missing')
          }
          tokenMatches.mockClear()
          translations.mockClear()
          const toast = React.createElement(TerminalErrorToast, {
            error,
            agentId: 'codex',
            paneOnClient: false,
            onDismiss: vi.fn()
          })
          if (view) {
            view.rerender(toast)
          } else {
            view = render(toast)
          }

          const tokenChecks = tokenMatches.mock.calls.filter(
            ([pattern]) =>
              pattern instanceof RegExp && pattern.source.includes('agent_(?:session|launch)_')
          ).length
          const startupTranslations = translations.mock.calls.filter(
            ([key]) =>
              typeof key === 'string' &&
              key.startsWith('auto.components.terminal.pane.AgentLaunchPaneNotice.')
          ).length
          const matchingRows = kind === 'startup' ? rowCount : kind === 'mixed' ? midpoint : 0
          // Classification and adaptation each visit a row at most once; known exits use two templates.
          expect(tokenChecks).toBeGreaterThanOrEqual(rowCount)
          expect(tokenChecks).toBeLessThanOrEqual(2 * rowCount)
          if (kind === 'startup') {
            expect(tokenChecks).toBe(2 * rowCount)
          }
          expect(startupTranslations).toBe(2 * matchingRows)
          expect(
            view.container.textContent?.match(/Codex exited while starting\./g) ?? []
          ).toHaveLength(matchingRows)
          expect(view.container.querySelector('a') !== null).toBe(kind !== 'startup')
          expect(view.container.textContent).not.toContain('agent_session_exited_during_start')
        }
        view?.unmount()
      }
    } finally {
      tokenMatches.mockRestore()
      translations.mockRestore()
    }
  })

  it.each([false, true])(
    'explains a known exit and retains reporting for independent errors: %s',
    (mixed) => {
      const code = 'agent_session_exited_during_start'
      const footer = '---\nOrca: 1.4.232\nOS: win32 10.0 (x64)\nShell: cmd.exe'
      const view = render(
        React.createElement(TerminalErrorToast, {
          error: `Error invoking remote method 'pty:spawn': Error: ${code}${mixed ? '\nPaste failed.' : ''}\n\n${footer}`,
          agentId: 'codex',
          paneOnClient: false,
          onDismiss: vi.fn()
        })
      )
      const text = view.container.textContent ?? ''
      expect(text).toContain(
        'Codex exited while starting. Run it in a terminal in this folder to see why, then try again.'
      )
      expect(text).not.toContain(code)
      if (mixed) {
        expect(text).toContain('Paste failed.')
      }
      expect(view.container.querySelectorAll('a')).toHaveLength(mixed ? 1 : 0)
    }
  )

  it.each([
    'agent_session_operation_unknown',
    'agent_session_claim_unavailable',
    'agent_launch_future_failure'
  ])('preserves uncertainty for a startup string without proof of failure: %s', (code) => {
    const text = humanizeTerminalError(
      `Error invoking remote method 'pty:spawn': Error: ${code}`,
      'codex'
    )
    expect(text).toBe("Couldn't confirm Codex started. Check its terminal before trying again.")
  })

  it('replaces the pane-owner-unverified code with actionable copy', () => {
    const humanized = humanizeTerminalError('terminal_pane_owner_unverified')
    expect(humanized).not.toContain('terminal_pane_owner_unverified')
    expect(humanized).toContain('Click Retry to try reconnecting now')
    expect(humanized).toContain('Orca left the saved session unchanged')
    expect(humanized).not.toContain('was not closed or deleted')
  })

  it('identifies the owner-unverified safety state', () => {
    expect(isPaneOwnerUnverifiedError('terminal_pane_owner_unverified')).toBe(true)
    expect(isPaneOwnerUnverifiedError('Paste failed.')).toBe(false)
    expect(isPaneOwnerUnverifiedError('Paste failed.\nterminal_pane_owner_unverified')).toBe(false)
  })

  it('humanizes an owner marker without classifying mixed errors as safe warnings', () => {
    const mixed = humanizeTerminalError('Paste failed.\nterminal_pane_owner_unverified')
    expect(mixed).toContain('Paste failed.')
    expect(mixed).toContain("Orca couldn't verify this terminal's owner.")
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

  // Older daemons return raw session-absence classes; humanize them without asking the user to file an issue.
  it('replaces the daemon session-absence string and its id', () => {
    const humanized = humanizeTerminalError(
      "Error invoking remote method 'pty:spawn': SessionNotFoundError: Session not found: wt-1@@pane-a"
    )
    expect(humanized).not.toContain('SessionNotFoundError')
    expect(humanized).not.toContain('wt-1@@pane-a')
    expect(humanized).toContain('Open a new terminal to continue')
    expect(isExplainedTerminalError('Session not found: wt-1@@pane-a')).toBe(true)
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

  // Retired output delivery leaves the agent running; suggesting a new terminal would abandon it.
  it('describes a retired output source as reconnecting, not as a lost session', () => {
    const humanized = humanizeTerminalError(
      'SSH_PTY_SOURCE_RESTORE_REQUIRED: remote:2f1c:pty-7 checkpointUnavailable'
    )
    expect(humanized).not.toContain('SSH_PTY_SOURCE_RESTORE_REQUIRED')
    expect(humanized).not.toContain('remote:2f1c:pty-7')
    expect(humanized).not.toContain('checkpointUnavailable')
    expect(humanized).not.toContain('Open a new terminal')
    expect(humanized).toContain('still running')
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
    expect(humanized).toContain('belongs to another host connection')
    expect(humanized).toContain('Open a new terminal')
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

  it('omits client details for a remote pane whose session cannot be reattached', async () => {
    const error = "Error invoking remote method 'pty:attach': Error: Session not found: pty-7"
    const remote = render(
      React.createElement(TerminalErrorToast, { error, paneOnClient: false, onDismiss: vi.fn() })
    )
    expect(remote.container.textContent).toContain("couldn't reattach")
    await waitFor(() => expect(environmentMocks.resolveFooter).not.toHaveBeenCalled())
    expect(remote.container.textContent).not.toContain('OS:')
    cleanup()

    const local = render(React.createElement(TerminalErrorToast, { error, onDismiss: vi.fn() }))
    await waitFor(() => expect(local.container.textContent).toContain('OS: darwin'))
  })

  it('shows the issue request once for a host error that already asks for one', () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error:
          'Failed to spawn shell "/bin/zsh": boom (shell: /bin/zsh). If this persists, please file an issue.',
        onDismiss: vi.fn()
      })
    )

    expect(view.container.textContent?.match(/If this persists/g)).toHaveLength(1)
    expect(view.container.textContent).toContain('(shell: /bin/zsh).')
  })

  it('renders owner-unverified as a warning without an issue link', () => {
    const onRetry = vi.fn().mockResolvedValue(true)
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: 'terminal_pane_owner_unverified',
        onDismiss: vi.fn(),
        onRetry
      })
    )

    const toast = view.container.querySelector('[data-terminal-error-toast]')
    expect(toast?.getAttribute('data-terminal-error-kind')).toBe('owner-unverified')
    expect(toast?.querySelector('a')).toBeNull()
    expect(toast?.textContent).toContain('Orca left the saved session unchanged')
    expect(view.getByRole('button', { name: 'Retry' }).getAttribute('data-slot')).toBe('button')
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('keeps Retry available when the recovery attempt rejects', async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error('recovery unavailable'))
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: 'terminal_pane_owner_unverified',
        onDismiss: vi.fn(),
        onRetry
      })
    )

    fireEvent.click(view.getByRole('button', { name: 'Retry' }))

    await waitFor(() =>
      expect((view.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('explains when Retry is temporarily unavailable', async () => {
    const onRetry = vi.fn().mockResolvedValue(false)
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: 'terminal_pane_owner_unverified',
        onDismiss: vi.fn(),
        onRetry
      })
    )

    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(view.container.textContent).toContain('Retry could not reconnect yet')
    )
  })

  // #30486: Retry was the only action, so a pane whose owner stays unverifiable looped on it.
  it('offers a new terminal beside Retry and leaves this pane alone', () => {
    const onRetry = vi.fn().mockResolvedValue(false)
    const onOpenNewTerminal = vi.fn()
    const onDismiss = vi.fn()
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: 'terminal_pane_owner_unverified',
        onDismiss,
        onRetry,
        onOpenNewTerminal
      })
    )

    fireEvent.click(view.getByRole('button', { name: 'Open new terminal' }))
    expect(onOpenNewTerminal).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

// The shape a missing folder workspace reaches the toast in when its terminal spawn is rejected.
const MISSING_FOLDER_ERROR =
  "Error invoking remote method 'pty:spawn': Error: folder_workspace_path_missing:/Users/me/ara_company"

describe('TerminalErrorToast folder workspace path errors', () => {
  it('replaces the raw missing-folder code with actionable copy', () => {
    const humanized = humanizeTerminalError(MISSING_FOLDER_ERROR)

    expect(humanized).not.toContain('folder_workspace_path_missing')
    expect(humanized).toBe(
      "Error invoking remote method 'pty:spawn': Error: Orca cannot find /Users/me/ara_company. Remove and re-import the folder."
    )
  })

  it('keeps unrelated lines when one line is a folder path error', () => {
    const humanized = humanizeTerminalError(
      ['folder_workspace_path_not_directory:/srv/app', 'Another error'].join('\n')
    )

    expect(humanized).toBe(['/srv/app exists, but it is not a folder.', 'Another error'].join('\n'))
  })

  it('humanizes the ambiguous-connection code thrown without a path', () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: 'folder_workspace_connection_ambiguous',
        onDismiss: vi.fn()
      })
    )

    const toast = view.container.querySelector('[data-terminal-error-toast]')
    expect(toast?.textContent).toContain(
      'Orca cannot tell which SSH connection owns this folder scope.'
    )
    expect(toast?.textContent).not.toContain('folder_workspace_connection_ambiguous')
    expect(toast?.querySelector('a')).toBeNull()
  })

  it('keeps the issue link when an unrelated error shares the toast', () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: [MISSING_FOLDER_ERROR, 'Failed to spawn shell "/bin/zsh": boom'].join('\n'),
        onDismiss: vi.fn()
      })
    )

    const toast = view.container.querySelector('[data-terminal-error-toast]')
    expect(toast?.textContent).toContain('Orca cannot find /Users/me/ara_company')
    expect(toast?.querySelector('a')?.textContent).toBe('file an issue')
  })

  it('does not ask the user to file an issue for a folder they can fix', () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: MISSING_FOLDER_ERROR,
        onDismiss: vi.fn()
      })
    )

    const toast = view.container.querySelector('[data-terminal-error-toast]')
    expect(toast?.textContent).toContain('Orca cannot find /Users/me/ara_company')
    expect(toast?.textContent).not.toContain('folder_workspace_path_missing')
    expect(toast?.textContent).not.toContain('If this persists')
    expect(toast?.querySelector('a')).toBeNull()
  })
})

it('keeps an existing environment footer without asking to report an explained folder error', () => {
  const footer =
    '---\nOrca: 1.4.178-rc.2\nOS: win32 10.0 (x64)\nShell: C:\\Windows\\System32\\cmd.exe'
  const error = `folder_workspace_path_not_directory:C:\\work\\folder:file\n\n${footer}`
  const view = render(React.createElement(TerminalErrorToast, { error, onDismiss: vi.fn() }))
  expect(view.container.textContent).toContain(
    'C:\\work\\folder:file exists, but it is not a folder.'
  )
  expect(view.container.textContent).toContain(footer)
  expect(view.container.querySelector('a')).toBeNull()
  expect(environmentMocks.resolveFooter).not.toHaveBeenCalled()
})

it('uses existing Korean recovery copy and preserves the path', async () => {
  await i18n.changeLanguage('ko')
  try {
    const path = '/tmp/project: folder'
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: `folder_workspace_path_missing:${path}`,
        onDismiss: vi.fn()
      })
    )
    expect(view.container.textContent).toContain(
      i18n.t('auto.lib.folderWorkspacePathStatus.createError.description.missing', { path })
    )
    expect(view.container.textContent).toContain(path)
    expect(view.container.textContent).not.toContain('folder_workspace_path_missing')
    expect(view.container.querySelector('a')).toBeNull()
  } finally {
    await i18n.changeLanguage('en')
  }
})
