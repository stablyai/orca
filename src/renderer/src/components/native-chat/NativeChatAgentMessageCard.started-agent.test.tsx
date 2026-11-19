// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './messages/actions/native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import {
  initialStore,
  from,
  resetSenderStore
} from './messages/agent-senders/native-chat-agent-sender.test-fixture'
import { MessageRow } from './messages/rows/NativeChatMessageRow'
import { projectStructuredAgentStartItem } from '../../../../shared/native-chat/transcript/messages/structured-agent-start-projection'
import { isAdmissibleAgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-schemas'
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

function renderStart(agent?: string): void {
  // A released worker: no live or retained row names its agent.
  const reloaded: unknown = JSON.parse(
    JSON.stringify({
      itemId: 'start',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'agent-start',
        dispatchId: 'd',
        worker: from.senders[1],
        task: 'Say hello',
        ...(agent ? { agent } : {})
      }
    })
  )
  if (!isAdmissibleAgentJournalRenderItem(reloaded)) {
    throw new Error('start item was refused')
  }
  render(
    <MessageRow
      message={projectStructuredAgentStartItem(reloaded)!}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
      runtimeContext={{ worktreeId: 'workspace', worktreePath: null, target: { kind: 'local' } }}
    />
  )
}

it('keeps the started agent icon once the worker has no row', () => {
  renderStart('claude')
  expect(screen.getByTestId('agent-icon')).toHaveTextContent('claude')
})

it('keeps a worker update card on the agent its sender recorded', () => {
  const source: unknown = {
    kind: 'agent',
    senders: [{ ...from.senders[1], relation: 'worker', agent: 'codex' }],
    orchestration: { message: 'mail-notice', mailbox: 'term_9', dispatchId: null, messages: [] }
  }
  const parsed = readAgentMessageSource(source)!
  render(
    <MessageRow
      message={{
        id: 'update',
        role: 'user',
        blocks: [{ type: 'text', text: 'Done' }],
        timestamp: 1,
        source: 'transcript',
        from: parsed
      }}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
      runtimeContext={{ worktreeId: 'workspace', worktreePath: null, target: { kind: 'local' } }}
    />
  )
  expect(screen.getByTestId('agent-icon')).toHaveTextContent('codex')
})
