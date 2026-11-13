// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { agentSessionFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { createStructuredAgentSessionMessageProjection } from '../../../../../../shared/agent-session/view/structured-agent-session-message-stream'
import {
  nativeChatNoticeBlock,
  nativeChatNoticeDisclosureKeys
} from '../../../../../../shared/native-chat/native-chat-notice'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../disclosure/native-chat-disclosure-store'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { NativeChatCollapsedNotice } from './NativeChatCollapsedNotice'

afterEach(cleanup)

function item(itemId: string, body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  const sequence = Number(itemId.slice(1))
  return { itemId, revision: 1, sequence, observedAt: sequence, body }
}

function codexRetry(itemId: string): AgentJournalRenderItem {
  const head = `{"error":{"message":"stream disconnected ${itemId}"},"willRetry":true}`
  return item(itemId, {
    kind: 'status',
    tone: 'warning',
    ...agentSessionFailureWords(
      {
        kind: 'providerRetrying',
        detail: { text: `stream disconnected ${itemId}`, audience: 'person' }
      },
      { surface: 'row', agentName: 'Codex' }
    ),
    providerFrame: {
      provider: 'codex',
      kind: 'notification:error',
      payload: { head, byteLength: head.length, digest: 'synthetic', truncated: false }
    }
  })
}

const reply = (itemId: string): AgentJournalRenderItem =>
  item(itemId, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Partial answer' }]
  })

const project = createStructuredAgentSessionMessageProjection()

function Transcript({ items }: { items: AgentJournalRenderItem[] }) {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      {project(items, [], []).map((message) => {
        const notice = nativeChatNoticeBlock(message.blocks)
        return notice ? (
          <div key={message.id} data-row={message.id}>
            <NativeChatNoticeRow
              block={notice}
              messageId={message.id}
              disclosureKeys={nativeChatNoticeDisclosureKeys(message)}
            />
          </div>
        ) : null
      })}
    </NativeChatDisclosureContext.Provider>
  )
}

it('keeps an opened retry row open through new attempts, older pages and trims that keep its attempt', () => {
  const [r1, r2, r3, r4, r6] = ['r1', 'r2', 'r3', 'r4', 'r6'].map(codexRetry)
  const { container, rerender } = render(<Transcript items={[r2, r3]} />)
  const row = (id: string) =>
    container.querySelector<HTMLDetailsElement>(`[data-row="${id}"] details`)!
  expect(row('r3').open).toBe(false)
  fireEvent.click(row('r3').querySelector('summary')!)
  expect(row('r3').open).toBe(true)

  rerender(<Transcript items={[r1!, r2!, r3!]} />)
  expect(row('r3').open).toBe(true)

  rerender(<Transcript items={[r1!, r2!, r3!, r4!]} />)
  expect(row('r4').open).toBe(true)
  expect(row('r4')).toHaveTextContent('Codex is retrying: stream disconnected r4.')

  rerender(<Transcript items={[r3!, r4!]} />)
  expect(row('r4').open).toBe(true)

  rerender(<Transcript items={[r3!, r4!, reply('r5'), r6!]} />)
  expect(row('r4').open).toBe(true)
  expect(row('r6').open).toBe(false)

  // The attempt that held the choice is no longer loaded: the documented reset.
  rerender(<Transcript items={[r4!]} />)
  expect(row('r4').open).toBe(false)
})

it('shows a retry with no provider frame as its own text once opened', () => {
  const { container } = render(
    <NativeChatNoticeRow
      block={{
        type: 'text',
        tone: 'warning',
        text: 'Claude hit a temporary problem and is retrying. Retry 2 of 10.\nLast error: HTTP 529 overloaded.',
        failure: {
          kind: 'providerRetrying',
          detail: { text: '{"type":"system","subtype":"api_retry"}', audience: 'log' },
          retry: { error: 'overloaded', status: 529, attempt: 2, maxRetries: 10 }
        }
      }}
    />
  )
  const details = container.querySelector('details')!
  expect(details.open).toBe(false)
  expect(details.querySelector('[data-native-chat-code-content]')).toHaveTextContent(
    'Claude hit a temporary problem and is retrying. Retry 2 of 10. Last error: HTTP 529 overloaded.'
  )
  expect(details.querySelector('[data-native-chat-code-content]')).not.toHaveTextContent(
    'api_retry'
  )
})

it.each([
  [
    '  Codex is retrying: connection interrupted.  ',
    'connection interrupted',
    'Codex is retrying: connection interrupted.'
  ],
  ['Retry scheduled.', 'connection interrupted', 'Retry scheduled.\n\nconnection interrupted']
])(
  'shows distinct person-facing retry detail without repeating embedded detail',
  (text, detail, expected) => {
    const { container } = render(
      <NativeChatCollapsedNotice
        look={{ kind: 'collapsed-notice', label: 'retrying' }}
        block={{
          type: 'text',
          tone: 'warning',
          text,
          failure: { kind: 'providerRetrying', detail: { text: detail, audience: 'person' } }
        }}
      />
    )
    expect(container.querySelector('[data-native-chat-code-content]')?.textContent?.trim()).toBe(
      expected
    )
  }
)
