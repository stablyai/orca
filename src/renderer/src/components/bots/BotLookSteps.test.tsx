// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

const mocks = vi.hoisted(() => ({ read: vi.fn(), messages: new Array<NativeChatMessage>() }))
vi.mock('../native-chat/session/structured/read/use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: mocks.read
}))
vi.mock(
  '../native-chat/conversation/projection/structured-agent-session-message-projection',
  () => ({
    projectStructuredAgentSessionMessages: () => mocks.messages
  })
)

import { BotLookSteps } from './BotLookSteps'

describe('a running look’s steps', () => {
  it('reads the look’s own session without marking it viewed', () => {
    mocks.read.mockReturnValue({ state: { items: [], submissions: [] } })
    mocks.messages = [
      {
        id: 'm1',
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [
          {
            type: 'tool-call',
            name: 'Bash',
            callId: '1',
            input: { command: 'orca connector read ENG-9142' },
            state: 'running'
          }
        ]
      }
    ]
    render(<BotLookSteps bot={{ hostId: 'local' }} sessionId="look-1" />)
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'look-1', isViewed: false })
    )
    expect(screen.getByText('Reading ENG-9142')).toBeTruthy()
  })
})
