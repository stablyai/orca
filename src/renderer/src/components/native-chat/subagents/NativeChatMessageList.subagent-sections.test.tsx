// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from '../messages/actions/native-chat-tooltip-test-harness'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('../media/visuals/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalRenderItem
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'

import type { NativeChatSubagentState } from '../../../../../shared/native-chat/native-chat-types'

import { projectStructuredItemsToNativeChat } from '../../../../../shared/agent-session/view/structured-agent-session-projection'

import { NativeChatMessageList } from '../NativeChatMessageList'

import { session, stubLayout } from '../viewport/virtualization/native-chat-windowing-test-harness'

{
  function journalItem(
    itemId: string,
    body: AgentJournalItemBody,
    sequence: number,
    linkage: AgentJournalProducerLinkage = {}
  ): AgentJournalRenderItem {
    return { itemId, body, sequence, observedAt: sequence * 1000, revision: 1, ...linkage }
  }

  const child: AgentJournalProducerLinkage = { agentId: 'task-1', producerKind: 'agent' }
  const patch = '@@ -1 +1 @@\n-before\n+after'
  const itemsWith = (
    state: NativeChatSubagentState,
    answered: boolean
  ): AgentJournalRenderItem[] => [
    journalItem(
      'ask',
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Review it' }] },
      1
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
            agents: [{ id: 'task-1', label: 'explore the lane', state }]
          }
        ]
      },
      2
    ),
    journalItem(
      'child-said',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'The PR is CLEAN.' }] },
      3,
      child
    ),
    journalItem(
      'child-edit',
      {
        kind: 'diff',
        path: 'src/a.ts',
        patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length }
      },
      4,
      child
    ),
    ...(answered
      ? [
          journalItem(
            'answer',
            {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Delegated; nothing to fix.' }]
            },
            5
          )
        ]
      : [])
  ]

  /** `waiting`: the session runs and has produced nothing since the roster. */
  function listOf(state: NativeChatSubagentState, waiting = false): React.JSX.Element {
    const items = itemsWith(state, !waiting)
    return (
      <NativeChatMessageList
        session={session(projectStructuredItemsToNativeChat(items))}
        journalItems={items}
        isWorking={waiting}
        expandSignal={false}
      />
    )
  }

  describe("a subagent's rows in the transcript", () => {
    afterEach(cleanup)
    let restoreLayout = (): void => {}
    beforeEach(() => {
      restoreLayout = stubLayout()
    })
    afterEach(() => {
      restoreLayout()
      vi.restoreAllMocks()
    })

    // Journal turn records own subagent edits, even when a newer send is queued or the opener is unloaded.
    it("counts a subagent's edit in the turn the journal says it was made in", () => {
      const say = (itemId: string, role: 'user' | 'assistant', text: string, sequence: number) =>
        journalItem(itemId, { kind: 'message', role, blocks: [{ type: 'text', text }] }, sequence)
      const turn = (turnId: string, userItemId: string, sequence: number) =>
        journalItem(
          `turn-${turnId}`,
          { kind: 'turn', turnId, state: 'completed', userItemId, startedAt: sequence * 1000 },
          sequence
        )
      const childEdit = (itemId: string, path: string, sequence: number) =>
        journalItem(
          itemId,
          {
            kind: 'diff',
            path,
            patch: { head: patch, truncated: false, digest: path, byteLength: patch.length }
          },
          sequence,
          child
        )
      const [ask, spawn] = itemsWith('completed', false)
      const items = [
        ask!,
        turn('1', 'ask', 2),
        { ...spawn!, sequence: 3 },
        say('ask-2', 'user', 'And the tests?', 4),
        childEdit('child-edit', 'src/a.ts', 5),
        say('answer-1', 'assistant', 'Edited a.', 6),
        turn('2', 'ask-2', 7),
        say('answer-2', 'assistant', 'Tests pass.', 8),
        // Its opener is outside the loaded window, so the turn keys to its own record.
        turn('3', 'older-send', 9),
        childEdit('child-woke', 'src/b.ts', 10),
        say('answer-3', 'assistant', 'Picked up the result.', 11)
      ]
      render(
        <NativeChatMessageList
          session={session(projectStructuredItemsToNativeChat(items))}
          journalItems={items}
          isWorking={false}
          expandSignal={false}
        />
      )
      const rollups = screen.getAllByRole('button', { name: /src\/[ab].ts/ })
      expect(rollups.map((rollup) => rollup.getAttribute('aria-label'))).toEqual([
        expect.stringMatching(/src\/a.ts/),
        expect.stringMatching(/src\/b.ts/)
      ])
      const inOrder = [
        screen.getByText('Edited a.'),
        rollups[0]!,
        screen.getByText('Tests pass.'),
        screen.getByText('Picked up the result.'),
        rollups[1]!
      ]
      for (const [index, node] of inOrder.slice(1).entries()) {
        expect(inOrder[index]!.compareDocumentPosition(node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      }
    })

    it('keeps a roster list open or closed past its row unmounting, and hides its sections while closed', () => {
      const items = itemsWith('completed', true)
      const view = (withRoster: boolean) => {
        const shown = withRoster ? items : items.filter((next) => next.itemId !== 'spawn')
        return (
          <NativeChatMessageList
            session={session(projectStructuredItemsToNativeChat(shown))}
            journalItems={shown}
            isWorking={false}
            expandSignal={false}
          />
        )
      }
      const { rerender } = render(view(true))
      fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))
      fireEvent.click(screen.getByRole('button', { name: /explore the lane/, expanded: false }))
      expect(screen.getByText('The PR is CLEAN.')).toBeInTheDocument()

      rerender(view(false))
      rerender(view(true))
      expect(screen.getByRole('button', { name: /Ran 1 subagent/, expanded: true })).toBeVisible()

      fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))
      expect(screen.getByText('The PR is CLEAN.')).toBeInTheDocument()
    })

    it("keeps the reader's choice over the frontier, in either direction", () => {
      const { rerender } = render(listOf('working', true))
      fireEvent.click(screen.getByRole('button', { name: /explore the lane/, expanded: true }))
      rerender(listOf('working', true))
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: /explore the lane/, expanded: false }))
      rerender(listOf('working'))
      expect(screen.getByText('The PR is CLEAN.')).toBeInTheDocument()
    })
  })
}
