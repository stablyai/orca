// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const environmentMocks = vi.hoisted(() => ({
  resolveFooter: vi.fn(async () => '---\nOrca: test')
}))

vi.mock('@/lib/client-environment-info', () => ({
  resolveClientEnvironmentFooter: environmentMocks.resolveFooter
}))

import { TerminalErrorToast } from './TerminalErrorToast'

afterEach(() => {
  cleanup()
})

const SIGN_IN_AWAITED =
  "Error invoking remote method 'runtimeEnvironments:call': Error: pwhost needs you to sign in. Reconnect to sign in."

describe('TerminalErrorToast for a host waiting for the user to sign in', () => {
  it('reads as the sentence main wrote, as an SSH state rather than a bug to report', () => {
    const view = render(
      React.createElement(TerminalErrorToast, { error: SIGN_IN_AWAITED, onDismiss: vi.fn() })
    )

    const toast = view.container.querySelector('[data-terminal-error-toast]')
    expect(toast?.getAttribute('data-terminal-error-kind')).toBe('ssh')
    expect(view.container.textContent).toContain(
      'pwhost needs you to sign in. Reconnect to sign in.'
    )
    expect(view.container.textContent).not.toContain('Error invoking remote method')
    expect(view.container.textContent).not.toContain('file an issue')
    expect(environmentMocks.resolveFooter).not.toHaveBeenCalled()
  })

  it('treats a cancelled sign-in the same way', () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error:
          "Error invoking remote method 'pty:spawn': Error: SSH sign-in for pwhost was cancelled. Reconnect to sign in again.",
        onDismiss: vi.fn()
      })
    )

    expect(view.container.textContent).not.toContain('file an issue')
    expect(view.container.textContent).toContain('SSH sign-in for pwhost was cancelled.')
  })

  it('keeps the issue link when another failure shares the toast', () => {
    const view = render(
      React.createElement(TerminalErrorToast, {
        error: `${SIGN_IN_AWAITED}\nPaste failed.`,
        onDismiss: vi.fn()
      })
    )

    expect(view.container.textContent).toContain('file an issue')
  })
})
