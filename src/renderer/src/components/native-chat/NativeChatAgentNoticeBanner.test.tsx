// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatAgentNoticeBanner } from './NativeChatAgentNoticeBanner'

afterEach(cleanup)

function noticeMessage(noticeKind: 'generic' | 'login-required'): NativeChatMessage {
  return {
    id: 'notice-1',
    role: 'system',
    blocks: [{ type: 'text', text: 'placeholder' }],
    timestamp: null,
    source: 'transcript',
    noticeKind
  }
}

describe('NativeChatAgentNoticeBanner', () => {
  it('renders a plain descriptive banner with no action for a generic notice', () => {
    render(
      <NativeChatAgentNoticeBanner
        message={noticeMessage('generic')}
        text="Context was compacted."
      />
    )

    expect(screen.getByText('Context was compacted.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows Reauthenticate account and Go to Terminal for a login-required notice', () => {
    const onReauthenticateAccount = vi.fn().mockResolvedValue({ ok: true })
    const onSwitchToTerminal = vi.fn()

    render(
      <NativeChatAgentNoticeBanner
        message={noticeMessage('login-required')}
        text="Please run /login."
        onReauthenticateAccount={onReauthenticateAccount}
        onSwitchToTerminal={onSwitchToTerminal}
      />
    )

    expect(screen.getByRole('button', { name: /Reauthenticate account/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Go to Terminal/i }))
    expect(onSwitchToTerminal).toHaveBeenCalledTimes(1)
  })

  it('omits the reauthenticate button when no handler is wired (e.g. SSH-remote pane)', () => {
    render(
      <NativeChatAgentNoticeBanner
        message={noticeMessage('login-required')}
        text="Please run /login."
        onSwitchToTerminal={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: /Reauthenticate account/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Go to Terminal/i })).toBeInTheDocument()
  })

  it('shows a success message inline after a successful reauthentication', async () => {
    const onReauthenticateAccount = vi.fn().mockResolvedValue({ ok: true })

    render(
      <NativeChatAgentNoticeBanner
        message={noticeMessage('login-required')}
        text="Please run /login."
        onReauthenticateAccount={onReauthenticateAccount}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Reauthenticate account/i }))

    await waitFor(() => expect(onReauthenticateAccount).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText(/Account reauthenticated/i)).toBeInTheDocument())
  })

  it('shows the descriptive error inline when reauthentication fails', async () => {
    const onReauthenticateAccount = vi.fn().mockResolvedValue({
      ok: false,
      message: 'No Claude account is configured for this pane yet.'
    })

    render(
      <NativeChatAgentNoticeBanner
        message={noticeMessage('login-required')}
        text="Please run /login."
        onReauthenticateAccount={onReauthenticateAccount}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Reauthenticate account/i }))

    await waitFor(() =>
      expect(
        screen.getByText('No Claude account is configured for this pane yet.')
      ).toBeInTheDocument()
    )
  })
})
