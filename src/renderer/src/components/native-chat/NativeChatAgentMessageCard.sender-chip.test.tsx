// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './messages/actions/native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import { openAgentMessageSender } from '@/lib/agent-session/open/open-agent-message-sender'
import {
  initialStore,
  resetSenderStore
} from './messages/agent-senders/native-chat-agent-sender.test-fixture'
import { NativeChatAgentMessageCard } from './messages/rows/NativeChatAgentMessageCard'
import type { AgentMessageSource } from '../../../../shared/agent-session/journal/agent-session-message-source'

vi.mock('@/lib/agent-session/open/open-agent-message-sender', () => ({
  openAgentMessageSender: vi.fn()
}))

beforeEach(() => resetSenderStore())

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAppStore.setState(initialStore, true)
})

it("opens the worker from its name in the row, without unfolding the row's message", () => {
  const from: AgentMessageSource = {
    kind: 'agent',
    orchestration: null,
    senders: [
      {
        name: 'Build cards',
        party: { address: 'term_0', terminalHandle: 'term_0', orcaSessionId: null }
      }
    ]
  }
  render(
    <NativeChatAgentMessageCard
      message={{
        id: 'mail',
        role: 'user',
        source: 'transcript',
        blocks: [{ type: 'text', text: 'The cards are built.\n\nScreens are in the PR.' }],
        timestamp: 1,
        from
      }}
      from={from}
      runtimeContext={{ worktreeId: 'workspace', worktreePath: null, target: { kind: 'local' } }}
      onRefolded={() => {}}
    />
  )

  const chip = screen.getByRole('button', { name: 'Open Build cards' })
  expect(chip).toHaveTextContent('Build cards')
  fireEvent.click(chip)

  expect(openAgentMessageSender).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
  expect(screen.queryByText('Screens are in the PR.')).not.toBeInTheDocument()
})
