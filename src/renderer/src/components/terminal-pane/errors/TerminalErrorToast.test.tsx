// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalErrorToast } from './TerminalErrorToast'

vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, text: string) => text
}))
afterEach(cleanup)

it('returns typing to the terminal when Retry disables its button', async () => {
  const user = userEvent.setup()
  let finishRetry!: (result: boolean) => void
  const retry = new Promise<boolean>((resolve) => {
    finishRetry = resolve
  })
  const terminal = document.createElement('textarea')
  document.body.append(terminal)
  try {
    render(
      <TerminalErrorToast
        error="terminal_pane_owner_unverified"
        paneOnClient={false}
        onDismiss={() => {}}
        onRetry={() => retry}
        onRestoreTerminalFocus={() => terminal.focus()}
      />
    )
    await user.click(screen.getByRole('button', { name: /^Retry$/ }))
    expect(document.activeElement).toBe(terminal)
    await user.keyboard('echo retry')
    expect(terminal.value).toBe('echo retry')
    finishRetry(true)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Retry$/ }).hasAttribute('disabled')).toBe(false)
    )
    expect(document.activeElement).toBe(terminal)
  } finally {
    terminal.remove()
  }
})
