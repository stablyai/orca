// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TerminalPaneDisconnectedBanner } from './TerminalPaneDisconnectedBanner'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

function renderBanner(banner: React.ReactNode): ReturnType<typeof render> {
  return render(<TooltipProvider>{banner}</TooltipProvider>)
}

describe('TerminalPaneDisconnectedBanner', () => {
  it('shows quiet bounded automatic recovery without a manual action', () => {
    renderBanner(
      <TerminalPaneDisconnectedBanner
        phase="backoff"
        onReconnect={vi.fn()}
        onRestoreTerminalFocus={vi.fn()}
      />
    )

    expect(screen.getByText('Reconnecting to remote runtime')).toBeInTheDocument()
    expect(screen.getByText(/retry for up to one minute/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers one explicit reconnect action after automatic recovery stops', async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()
    renderBanner(
      <TerminalPaneDisconnectedBanner
        phase="disconnected"
        onReconnect={onReconnect}
        onRestoreTerminalFocus={vi.fn()}
      />
    )

    expect(screen.getByText('Remote runtime disconnected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onReconnect).toHaveBeenCalledOnce()
  })
})

/**
 * STA-3077 step E-0. A reattach that fails without proving the shell is gone used to either
 * respawn silently — resuming the same agent a second time into one transcript — or leave the pane
 * frozen behind a raw error toast. It now renders here, with the two actions the design approved.
 */
describe('TerminalPaneDisconnectedBanner, unreachable SSH pane', () => {
  function renderUnreachable() {
    const onReconnect = vi.fn()
    const onStartNewTerminal = vi.fn()
    const onRestoreTerminalFocus = vi.fn()
    renderBanner(
      <TerminalPaneDisconnectedBanner
        phase="disconnected"
        variant="ssh-pane"
        onReconnect={onReconnect}
        onStartNewTerminal={onStartNewTerminal}
        onRestoreTerminalFocus={onRestoreTerminalFocus}
      />
    )
    return { onReconnect, onStartNewTerminal, onRestoreTerminalFocus }
  }

  it('offers exactly the two approved actions', async () => {
    const user = userEvent.setup()
    const { onReconnect, onStartNewTerminal } = renderUnreachable()

    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Try again',
      'Start a new terminal'
    ])

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onReconnect).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Start a new terminal' }))
    expect(onStartNewTerminal).toHaveBeenCalledOnce()
  })

  it('returns keyboard focus to this terminal after either action', async () => {
    const user = userEvent.setup()
    const onReconnect = vi.fn()
    const onStartNewTerminal = vi.fn()
    renderBanner(
      <>
        <textarea aria-label="Terminal input" />
        <TerminalPaneDisconnectedBanner
          phase="disconnected"
          variant="ssh-pane"
          onReconnect={onReconnect}
          onStartNewTerminal={onStartNewTerminal}
          onRestoreTerminalFocus={() =>
            screen.getByRole('textbox', { name: 'Terminal input' }).focus()
          }
        />
      </>
    )

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onReconnect).toHaveBeenCalledOnce()
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Start a new terminal' }))
    expect(onStartNewTerminal).toHaveBeenCalledOnce()
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveFocus()
  })

  it('keeps both actions inside the clipped pane at its supported narrow width', () => {
    renderUnreachable()
    const card = screen.getByRole('status')
    const banner = card.parentElement
    const buttons = screen.getAllByRole('button')

    expect(banner).toHaveAttribute('data-terminal-pane-disconnected-variant', 'ssh-pane')
    expect(banner).toHaveClass('@container/disconnected-banner', 'inset-x-0')
    expect(card).toHaveClass('max-h-full', 'overflow-y-auto')
    expect(buttons[0].parentElement).toHaveClass('@max-[240px]/disconnected-banner:justify-center')
    for (const button of buttons) {
      expect(button).toHaveAttribute('data-size', 'icon-xs')
    }
  })

  // The copy constraint as an oracle. Nothing here observed the process, so the UI may not claim
  // it died — and STYLEGUIDE.md forbids result verbs without result data either way.
  it('never asserts the shell is dead', () => {
    renderUnreachable()

    const banner = screen.getByRole('status')
    expect(banner.textContent).not.toMatch(/exit(ed)?|died|dead|terminated|killed|crashed|lost/i)
    expect(banner.textContent).toMatch(/may still be running/i)
  })

  // Replaces the deleted `describeReattachFailure` clause: wire tokens must not reach the pane.
  it('shows no wire token or raw error string', () => {
    renderUnreachable()

    const banner = screen.getByRole('status')
    expect(banner.textContent).not.toMatch(/SSH_|PTY "|ECONNRESET|pty-\d/)
  })

  // Guards the two-action clause from a banner that always renders the second button: the
  // remote-runtime variant has no record to retire, so it must keep exactly one action.
  it('keeps the remote-runtime variant single-action', () => {
    renderBanner(
      <TerminalPaneDisconnectedBanner
        phase="disconnected"
        onReconnect={vi.fn()}
        onRestoreTerminalFocus={vi.fn()}
      />
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
