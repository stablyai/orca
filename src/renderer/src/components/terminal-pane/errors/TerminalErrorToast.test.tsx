// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const environmentMocks = vi.hoisted(() => ({ resolveFooter: vi.fn() }))
vi.mock('@/lib/client-environment-info', () => ({
  resolveClientEnvironmentFooter: environmentMocks.resolveFooter
}))
import { TerminalErrorToast } from './TerminalErrorToast'
beforeEach(() => {
  environmentMocks.resolveFooter.mockReset()
  environmentMocks.resolveFooter.mockResolvedValue(
    ['---', 'Orca: 1.4.178-rc.2', 'OS: darwin 25.0.0 (arm64)', 'Shell: /bin/zsh'].join('\n')
  )
})
afterEach(cleanup)
const MISSING_FOLDER_ERROR =
  "Error invoking remote method 'pty:spawn': Error: folder_workspace_path_missing:/Users/me/ara_company"

describe('humanizeTerminalError', () => {
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

      expect(text).not.toContain(code)
      if (mixed) {
        expect(text).toContain('Paste failed.')
      }
      expect(view.container.querySelectorAll('a')).toHaveLength(mixed ? 1 : 0)
    }
  )
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

  it('omits client details for a remote pane whose session cannot be reattached', async () => {
    const error = "Error invoking remote method 'pty:attach': Error: Session not found: pty-7"
    const remote = render(
      React.createElement(TerminalErrorToast, { error, paneOnClient: false, onDismiss: vi.fn() })
    )

    expect(remote.container.textContent).not.toContain('OS:')
    cleanup()

    const local = render(React.createElement(TerminalErrorToast, { error, onDismiss: vi.fn() }))
    await waitFor(() => expect(local.container.textContent).toContain('OS: darwin'))
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

    expect(toast?.querySelector('a')).toBeNull()

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

describe('TerminalErrorToast folder workspace path errors', () => {
  it('humanizes the ambiguous-connection code thrown without a path', () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: 'folder_workspace_connection_ambiguous',
        onDismiss: vi.fn()
      })
    )

    const toast = view.container.querySelector('[data-terminal-error-toast]')

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

    expect(toast?.textContent).not.toContain('folder_workspace_path_missing')

    expect(toast?.querySelector('a')).toBeNull()
  })
})

it('keeps an existing environment footer without asking to report an explained folder error', () => {
  const footer =
    '---\nOrca: 1.4.178-rc.2\nOS: win32 10.0 (x64)\nShell: C:\\Windows\\System32\\cmd.exe'
  const error = `folder_workspace_path_not_directory:C:\\work\\folder:file\n\n${footer}`
  const view = render(React.createElement(TerminalErrorToast, { error, onDismiss: vi.fn() }))

  expect(view.container.textContent).toContain(footer)
  expect(view.container.querySelector('a')).toBeNull()
})

it('offers Close Pane only for a pane whose remote terminal was closed', () => {
  const onClosePane = vi.fn()
  const view = render(
    React.createElement(TerminalErrorToast, {
      error: 'Remote terminal was closed.',
      paneOnClient: false,
      onDismiss: vi.fn(),
      onClosePane
    })
  )
  fireEvent.click(view.getByText('Close Pane'))
  expect(onClosePane).toHaveBeenCalledTimes(1)

  view.rerender(
    React.createElement(TerminalErrorToast, {
      error: 'Paste failed.',
      paneOnClient: false,
      onDismiss: vi.fn(),
      onClosePane
    })
  )
  expect(view.queryByText('Close Pane')).toBeNull()
})
