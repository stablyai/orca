// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

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
import type * as EditNormalization from '../../../../shared/native-chat/tools/native-chat-edit-normalize'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

const cost = vi.hoisted(() => ({ edits: 0 }))
vi.mock(
  '../../../../shared/native-chat/tools/native-chat-edit-normalize',
  async (importOriginal) => {
    const actual = await importOriginal<typeof EditNormalization>()
    return {
      ...actual,
      editFilesFromToolPair: (...args: Parameters<typeof actual.editFilesFromToolPair>) => {
        cost.edits += 1
        return actual.editFilesFromToolPair(...args)
      }
    }
  }
)
// Pacing is not this test's subject.
vi.mock('./use-native-chat-paced-text', async (importOriginal) =>
  (await import('./native-chat-unpaced-text-fixture')).unpacedTextModule(importOriginal)
)

const { NativeChatMessageList } = await import('./NativeChatMessageList')
const { openToolRunMembers } = await import('./native-chat-tool-run-members-test-support')
let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const EMPTY: never[] = []
const loadEarlier = () => Promise.resolve('exhausted' as const)
function Transcript({ items }: { items: AgentJournalRenderItem[] }) {
  const messages = useStructuredAgentSessionMessages(items, EMPTY, EMPTY)
  const session: NativeChatLiveSession = {
    messages,
    status: 'working',
    sessionId: 'session',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier,
    readPhase: 'ready'
  }
  return <NativeChatMessageList session={session} isWorking expandSignal />
}

function row(index: number, body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  return { itemId: `item-${index}`, revision: 1, sequence: index, observedAt: index, body }
}

it('does not re-diff expanded historical edits when an unrelated answer streams', () => {
  const oldContent = Array.from({ length: 12 }, (_, index) => `old line ${index}`).join('\n')
  const newContent = oldContent.replace('old line 6', 'changed line 6')
  const items = Array.from({ length: 3 }, (_, index) =>
    row(index, {
      kind: 'tool-call',
      name: 'Edit',
      state: 'completed',
      input: { file_path: `file-${index}.ts`, old_string: oldContent, new_string: newContent }
    })
  )
  items.push(
    row(3, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Next task' }] })
  )
  const tail = row(4, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'answer' }]
  })
  const { rerender } = render(<Transcript items={[...items, tail]} />)
  expect(cost.edits).toBe(3)
  openToolRunMembers()
  cost.edits = 0
  for (let frame = 0; frame < 3; frame += 1) {
    rerender(
      <Transcript
        items={[
          ...items,
          {
            ...tail,
            revision: frame + 2,
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: `answer ${frame}` }]
            }
          }
        ]}
      />
    )
  }
  expect(cost.edits).toBe(0)
  expect(screen.getByText('answer 2')).toBeTruthy()
  expect(screen.getAllByText('changed line 6')).toHaveLength(3)

  rerender(
    <Transcript
      items={[
        row(0, {
          kind: 'tool-call',
          name: 'Edit',
          state: 'completed',
          input: { file_path: 'file-0.ts', old_string: oldContent, new_string: 'Revised edit' }
        }),
        ...items.slice(1),
        tail
      ]}
    />
  )
  expect(cost.edits).toBe(1)
  expect(screen.getByText('Revised edit')).toBeTruthy()
  expect(screen.getAllByText('changed line 6')).toHaveLength(2)
})
