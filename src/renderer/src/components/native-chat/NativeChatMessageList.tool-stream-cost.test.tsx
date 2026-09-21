// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type * as EditNormalization from '../../../../shared/native-chat-edit-normalize'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'

const cost = vi.hoisted(() => ({ edits: 0, milliseconds: 0 }))
vi.mock('../../../../shared/native-chat-edit-normalize', async (importOriginal) => {
  const actual = await importOriginal<typeof EditNormalization>()
  return {
    ...actual,
    editFilesFromToolPair: (...args: Parameters<typeof actual.editFilesFromToolPair>) => {
      cost.edits += 1
      const start = performance.now()
      const result = actual.editFilesFromToolPair(...args)
      cost.milliseconds += performance.now() - start
      return result
    }
  }
})
const { NativeChatMessageList } = await import('./NativeChatMessageList')
afterEach(cleanup)

const EMPTY: never[] = []
const loadEarlier = () => {}
function Transcript({ items }: { items: AgentJournalRenderItem[] }) {
  const messages = useStructuredAgentSessionMessages(items, EMPTY, EMPTY)
  const session: NativeChatLiveSession = {
    messages,
    status: 'working',
    sessionId: 'session',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier,
    readPhase: 'ready'
  }
  return (
    <NativeChatMessageList
      session={session}
      isWorking
      expandSignal
      fontScale={1}
      showTurnStatus={false}
    />
  )
}

function row(index: number, body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  return { itemId: `item-${index}`, revision: 1, sequence: index, observedAt: index, body }
}

it('does not re-diff expanded historical edits when an unrelated answer streams', () => {
  const oldContent = Array.from({ length: 400 }, (_, index) => `old line ${index}`).join('\n')
  const newContent = oldContent.replace('old line 200', 'changed line 200')
  const items = Array.from({ length: 20 }, (_, index) =>
    row(index, {
      kind: 'tool-call',
      name: 'Edit',
      state: 'completed',
      input: { file_path: `file-${index}.ts`, old_string: oldContent, new_string: newContent }
    })
  )
  items.push(
    row(20, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Next task' }] })
  )
  const tail = row(21, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'answer' }]
  })
  const { rerender } = render(<Transcript items={[...items, tail]} />)
  expect(cost.edits).toBe(20)
  cost.edits = 0
  cost.milliseconds = 0
  for (let frame = 0; frame < 20; frame += 1) {
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
  console.info('Historical edit work over 20 stream frames:', { ...cost })
  expect(cost.edits).toBe(0)
  expect(screen.getByText('answer 19')).toBeTruthy()
  expect(screen.getAllByText('changed line 200')).toHaveLength(20)

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
  expect(screen.getByText('Revised edit')).toBeTruthy()
  expect(screen.getAllByText('changed line 200')).toHaveLength(19)
})
