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

const call = (callId: string, command: string, state: 'running' | 'completed') => ({
  type: 'tool-call' as const,
  name: 'Bash',
  callId,
  input: { command },
  state
})

describe('a running look’s steps', () => {
  it('reads the look’s own session without marking it viewed, and labels each step', () => {
    mocks.read.mockReturnValue({ state: { items: [], submissions: [] } })
    mocks.messages = [
      {
        id: 'm1',
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [
          call('1', "orca connector read '#eng'", 'completed'),
          call('2', 'orca connector check slack:T1:C2:17.1', 'completed'),
          call('3', 'orca connector read ENG-9142', 'running'),
          call('4', '"${ORCA_CLI_COMMAND:-orca}" repo list', 'completed')
        ]
      }
    ]
    render(<BotLookSteps bot={{ hostId: 'local' }} sessionId="look-1" />)
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'look-1', isViewed: false })
    )
    expect(screen.getByText('Read #eng')).toBeTruthy()
    expect(screen.getByText('Checked a Slack thread')).toBeTruthy()
    expect(screen.getByText('Reading ENG-9142')).toBeTruthy()
    expect(screen.getByText('Ran orca repo list')).toBeTruthy()
  })
})
