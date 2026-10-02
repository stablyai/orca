// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import { session, stubLayout } from './native-chat-windowing-test-harness'

function journalItem(
  itemId: string,
  body: AgentJournalItemBody,
  sequence: number,
  linkage: AgentJournalProducerLinkage = {}
): AgentJournalRenderItem {
  return { itemId, body, sequence, observedAt: sequence * 1000, revision: 1, ...linkage }
}

/** A running turn that kicked off one working helper, which has written a row. `waiting`: the
 *  parent's newest output is its own call waiting on the helper, as Codex sends it. */
function itemsWith(waiting: boolean): AgentJournalRenderItem[] {
  return [
    journalItem('turn', { kind: 'turn', turnId: 'turn-1', state: 'running' }, 1),
    journalItem(
      'ask',
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Count things' }] },
      2
    ),
    journalItem(
      'spawn',
      {
        kind: 'message',
        role: 'system',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'group-1',
            agents: [{ id: 'task-1', label: 'counting_retry', state: 'working' }]
          }
        ]
      },
      3
    ),
    ...(waiting
      ? [
          journalItem(
            'wait',
            { kind: 'tool-call', name: 'wait', input: { receiverThreadIds: [] }, state: 'running' },
            4
          )
        ]
      : []),
    journalItem(
      'child-said',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Counting.' }] },
      5,
      { agentId: 'task-1', producerKind: 'agent' }
    )
  ]
}

const OPEN = (agentId?: string): boolean => agentId === 'task-1'
const SHUT = (): boolean => false

function listOf(waiting: boolean, isReasoningOpen: (agentId?: string) => boolean) {
  const items = itemsWith(waiting)
  return (
    <NativeChatMessageList
      session={session(projectStructuredItemsToNativeChat(items))}
      journalItems={items}
      isWorking
      isReasoningOpen={isReasoningOpen}
      expandSignal={false}
      fontScale={1}
    />
  )
}

describe("a helper's Thinking on an expanded roster", () => {
  let restoreLayout = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout()
  })
  afterEach(() => {
    restoreLayout()
    cleanup()
  })

  it.each([
    ['the session waits on the helper', true],
    ['the session does not wait on it', false]
  ])('keeps the list expanded as the helper starts and stops reasoning (%s)', (_, waiting) => {
    const { rerender } = render(listOf(waiting, OPEN))
    const run = () => screen.getByRole('button', { name: /Kicked off 1 subagent/ })
    if (run().getAttribute('aria-expanded') !== 'true') {
      fireEvent.click(run())
    }
    expect(run()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('counting_retry')).toBeInTheDocument()

    rerender(listOf(waiting, SHUT))
    expect(run()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('counting_retry')).toBeInTheDocument()

    rerender(listOf(waiting, OPEN))
    expect(run()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('counting_retry')).toBeInTheDocument()
  })
})
