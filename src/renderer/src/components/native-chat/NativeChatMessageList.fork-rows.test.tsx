// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatForkContext } from './native-chat-fork-context'
import { nativeChatForkEligibleItemIds } from './native-chat-fork-eligibility'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const turn = (id: string, state: 'completed' | 'running'): AgentJournalRenderItem => ({
  itemId: id,
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'turn',
    turnId: id,
    providerTurnId: id,
    state,
    ...(state === 'completed' ? { outcome: 'success' as const } : {})
  }
})
const message = (
  id: string,
  role: 'user' | 'assistant',
  turnItemId: string
): AgentJournalRenderItem => ({
  itemId: id,
  revision: 1,
  sequence: 2,
  observedAt: 2,
  turnScope: { kind: 'turn', turnItemId },
  body: { kind: 'message', role, blocks: [{ type: 'text', text: id }] }
})

describe('Branch in new chat on rendered assistant rows', () => {
  it('branches the selected answer, not its hidden completion row, while a later turn runs', () => {
    const request = vi.fn(async () => {})
    const items = [
      message('prompt-A', 'user', 'A'),
      turn('A', 'completed'),
      message('answer-A', 'assistant', 'A'),
      message('prompt-B', 'user', 'B'),
      turn('B', 'completed'),
      message('answer-B', 'assistant', 'B'),
      message('prompt-C', 'user', 'C'),
      turn('C', 'running'),
      message('answer-C', 'assistant', 'C')
    ].map((item, index) => ({ ...item, sequence: index + 1 }))
    const fork = Object.freeze({
      eligibleItemIds: nativeChatForkEligibleItemIds(items),
      pending: false,
      request
    })
    render(
      <TooltipProvider>
        <NativeChatForkContext.Provider value={fork}>
          <NativeChatMessageList
            session={{
              messages: projectStructuredAgentSessionMessages(items, [], []),
              status: 'ready',
              sessionId: 'parent',
              agent: 'codex',
              hasMore: false,
              loadingEarlier: false,
              olderHistoryGeneration: 0,
              loadEarlier: vi.fn(),
              readPhase: 'ready'
            }}
            journalItems={items}
            journalSubmissions={[]}
            isWorking={true}
            expandSignal={false}
          />
        </NativeChatForkContext.Provider>
      </TooltipProvider>
    )
    const offered = screen.getAllByRole('button', { name: 'Branch in new chat' })
    expect(offered).toHaveLength(2)
    fireEvent.click(offered[1]!)
    expect(request).toHaveBeenCalledExactlyOnceWith('answer-B')
    expect(offered[1]!.parentElement).toHaveClass('can-hover:opacity-0')
    expect(offered[1]!.parentElement).not.toHaveClass('opacity-0')
  })
})
