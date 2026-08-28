// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

afterEach(cleanup)

function sessionWith(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 'session-1',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: () => {},
    readPhase: 'ready'
  }
}

describe('NativeChatMessageList — agent notices', () => {
  it('renders a warning system notice as an alert banner, not an assistant bubble', () => {
    const onSwitchToTerminal = vi.fn()
    render(
      <NativeChatMessageList
        session={sessionWith([
          {
            id: 'notice-1',
            role: 'system',
            blocks: [{ type: 'text', text: 'Please run /login in Claude Code.' }],
            timestamp: null,
            source: 'transcript',
            notice: { level: 'warning' }
          }
        ])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        onSwitchToTerminal={onSwitchToTerminal}
      />
    )

    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('Please run /login in Claude Code.')
    expect(screen.getByRole('button', { name: /Switch to terminal view/i })).toBeInTheDocument()
    expect(screen.queryByLabelText('Copy message')).toBeNull()
  })

  it('keeps interrupt status as quiet system copy without a banner', () => {
    render(
      <NativeChatMessageList
        session={sessionWith([
          {
            id: 'interrupt-1',
            role: 'system',
            blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
            timestamp: null,
            source: 'transcript'
          }
        ])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        onSwitchToTerminal={vi.fn()}
      />
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(NATIVE_CHAT_INTERRUPTED_STATUS_TEXT)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Switch to terminal view/i })).toBeNull()
  })

  it('renders a metadata-absent system row through the quiet fallback', () => {
    render(
      <NativeChatMessageList
        session={sessionWith([
          {
            id: 'legacy-system-1',
            role: 'system',
            blocks: [{ type: 'text', text: 'Provider status from an older host.' }],
            timestamp: null,
            source: 'transcript'
          }
        ])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        onSwitchToTerminal={vi.fn()}
      />
    )

    expect(screen.getByText('Provider status from an older host.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: /Switch to terminal view/i })).toBeNull()
  })
})
