// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const environmentMocks = vi.hoisted(() => ({ resolveFooter: vi.fn() }))

vi.mock('@/lib/client-environment-info', () => ({
  resolveClientEnvironmentFooter: environmentMocks.resolveFooter
}))

import { TerminalErrorToast, humanizeTerminalError } from './TerminalErrorToast'

const STOPPED_SENTENCE =
  "The WSL distro Ubuntu is stopped, so Orca didn't start this terminal. Start the distro, then try again."

beforeEach(() => {
  environmentMocks.resolveFooter.mockReset()
  environmentMocks.resolveFooter.mockImplementation(async (overrides: { shell?: string } = {}) =>
    ['---', 'Orca: 1.0.0', 'OS: win32 10.0 (x64)', `Shell: ${overrides.shell ?? 'cmd.exe'}`].join(
      '\n'
    )
  )
})

afterEach(() => {
  cleanup()
})

describe('a held WSL terminal in the error banner', () => {
  it.each([
    ['terminal_held_wsl_distro_stopped:Ubuntu'],
    ["Error invoking remote method 'pty:spawn': Error: terminal_held_wsl_distro_stopped:Ubuntu"],
    ['Failed to create the startup terminal for C:\\w: terminal_held_wsl_distro_stopped:Ubuntu']
  ])('names the distro instead of the raw code (%s)', (error) => {
    const humanized = humanizeTerminalError(error)
    expect(humanized).toContain(STOPPED_SENTENCE)
    expect(humanized).not.toContain('terminal_held_wsl_distro')
  })

  it('reads an unchecked distro as unverifiable, not stopped', () => {
    expect(humanizeTerminalError('terminal_held_wsl_distro_unverifiable:Debian')).toBe(
      "Orca couldn't check whether the WSL distro Debian is running, so it didn't start this terminal. Start the distro, then try again."
    )
  })

  it('does not ask the user to file an issue for a held terminal', () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: 'terminal_held_wsl_distro_stopped:Ubuntu',
        onDismiss: vi.fn()
      })
    )
    expect(view.container.textContent).toContain(STOPPED_SENTENCE)
    expect(view.container.textContent).not.toContain('file an issue')
  })
})

describe('the error banner footer', () => {
  it('reports the shell whose spawn failed, not the default shell', async () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error:
          'Daemon failed to spawn shell "C:\\WINDOWS\\system32\\wsl.exe" with cwd "C:\\Users\\me": spawn failed',
        onDismiss: vi.fn()
      })
    )
    await waitFor(() =>
      expect(view.container.textContent).toContain('Shell: C:\\WINDOWS\\system32\\wsl.exe')
    )
    expect(view.container.textContent).not.toContain('Shell: cmd.exe')
  })

  it('keeps the default shell when the error names none', async () => {
    const view = render(
      React.createElement(TerminalErrorToast, { error: 'Paste failed.', onDismiss: vi.fn() })
    )
    await waitFor(() => expect(view.container.textContent).toContain('Shell: cmd.exe'))
    expect(environmentMocks.resolveFooter).toHaveBeenCalledWith({})
  })
})
