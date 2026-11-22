// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './messages/actions/native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import {
  initialStore,
  resetSenderStore
} from './messages/agent-senders/native-chat-agent-sender.test-fixture'
import { MessageRow } from './messages/rows/NativeChatMessageRow'
import { readAgentMessageSource } from '../../../../shared/agent-session/journal/agent-session-message-source'

vi.mock('@/components/agent/icons/agent-type-icon', () => ({
  AgentTypeIcon: ({ agentType }: { agentType: string | null | undefined }) => (
    <span data-testid="agent-icon">{agentType ?? '?'}</span>
  )
}))

beforeEach(() => resetSenderStore())

afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
})

// The sender as peer mail stores it: the label is the party, named by what the other computer sent.
function renderPeerMail(sender: Record<string, unknown>): void {
  const from = readAgentMessageSource({
    kind: 'agent',
    senders: [
      {
        party: {
          address: "orca_session_id:0d31576f-309e-42f7-8cf4-7e79e47a2cc2 on Alice's Mac",
          terminalHandle: null,
          orcaSessionId: null
        },
        host: "Alice's Mac",
        ...sender
      }
    ],
    orchestration: { message: 'mail-notice', mailbox: 'term_9', dispatchId: null, messages: [] }
  })!
  render(
    <MessageRow
      message={{
        id: 'peer',
        role: 'user',
        blocks: [{ type: 'text', text: 'Where is the install guide?' }],
        timestamp: 1,
        source: 'transcript',
        from
      }}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
      runtimeContext={{ worktreeId: 'workspace', worktreePath: null, target: { kind: 'local' } }}
    />
  )
}

it("shows another computer's bot by its name and carried avatar, with that computer's pill", () => {
  renderPeerMail({ name: 'Bot builder', bot: true, botAvatar: 'mascot:A1', agent: 'claude' })

  expect(screen.getByText('Bot builder')).toBeInTheDocument()
  expect(screen.getByText("Alice's Mac")).toBeInTheDocument()
  expect(screen.queryByTestId('agent-icon')).not.toBeInTheDocument()
  expect(document.querySelector('img[src*="A1"]')).not.toBeNull()
})
