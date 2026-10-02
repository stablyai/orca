// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { aiVaultSessionFixture } from '../../../../shared/ai-vault-session.test-fixture'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatSubagentMessageList } from './NativeChatSubagentMessageList'
import { session, stubLayout } from './native-chat-windowing-test-harness'

const mocks = vi.hoisted(() => ({ list: vi.fn(), transcript: vi.fn() }))
vi.mock('../agent-subagents/use-agent-subagent-sessions', () => ({
  useAgentSubagentSessions: mocks.list
}))
vi.mock('./use-native-chat-live-session', () => ({ useNativeChatLiveSession: mocks.transcript }))
afterEach(cleanup)
beforeEach(() => stubLayout())

it('keeps journal child replies in the selected sheet, including while the parent waits', () => {
  const items: AgentJournalRenderItem[] = [
    {
      itemId: 'ask',
      sequence: 1,
      revision: 1,
      observedAt: 1000,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Delegate a check' }] }
    },
    {
      itemId: 'spawn',
      sequence: 2,
      revision: 1,
      observedAt: 2000,
      body: {
        kind: 'message',
        role: 'system',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'group',
            agents: [{ id: 'child', label: 'Reviewer', state: 'working', startedAt: 1000 }]
          }
        ]
      }
    },
    {
      itemId: 'reply',
      sequence: 3,
      revision: 1,
      observedAt: 3000,
      agentId: 'child',
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Child answer' }] }
    }
  ]
  const child = aiVaultSessionFixture({
    id: 'child',
    sessionId: 'child',
    title: 'Reviewer',
    agent: 'codex',
    filePath: '/host/child.jsonl',
    createdAt: new Date(1000).toISOString(),
    subagent: { parentSessionId: 'parent', agentType: null, status: 'running' }
  })
  mocks.list.mockReturnValue({ loading: false, sessions: [child] })
  mocks.transcript.mockReturnValue(
    session(projectStructuredItemsToNativeChat([{ ...items[2]!, agentId: undefined }]))
  )
  render(
    <TooltipProvider>
      <NativeChatSubagentMessageList
        session={session(projectStructuredItemsToNativeChat(items))}
        journalItems={items}
        subagents={{ structuredSessionId: 'parent', target: { kind: 'local' } }}
        isWorking={true}
        workingStartedAt={1000}
        expandSignal={false}
        fontScale={1}
      />
    </TooltipProvider>
  )
  expect(screen.getByText('Delegate a check')).toBeTruthy()
  expect(screen.queryByText('Child answer')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /^1 subagent/ }))
  expect(screen.getAllByText('Child answer')).toHaveLength(1)
})
