// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatAgentNoticeBanner } from './NativeChatAgentNoticeBanner'

afterEach(cleanup)

function noticeMessage(noticeLevel: 'info' | 'warning' | 'error'): NativeChatMessage {
  return {
    id: 'notice-1',
    role: 'system',
    blocks: [{ type: 'text', text: 'placeholder' }],
    timestamp: null,
    source: 'transcript',
    notice: { level: noticeLevel }
  }
}

describe('NativeChatAgentNoticeBanner', () => {
  it('renders a descriptive status banner without a terminal action for info notices', () => {
    render(
      <NativeChatAgentNoticeBanner
        message={noticeMessage('info')}
        text="Conversation compacted"
        onSwitchToTerminal={vi.fn()}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('Conversation compacted')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows Switch to terminal view for a warning notice', () => {
    const onSwitchToTerminal = vi.fn()
    render(
      <NativeChatAgentNoticeBanner
        message={noticeMessage('warning')}
        text="Please run /login in Claude Code."
        onSwitchToTerminal={onSwitchToTerminal}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Please run /login in Claude Code.')
    fireEvent.click(screen.getByRole('button', { name: /Switch to terminal view/i }))
    expect(onSwitchToTerminal).toHaveBeenCalledTimes(1)
  })

  it('omits the terminal action when no handler is wired', () => {
    render(
      <NativeChatAgentNoticeBanner
        message={noticeMessage('warning')}
        text="Please run /login in Claude Code."
      />
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
