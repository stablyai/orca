// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, screen, within, act } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'

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

import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'

import type {
  NativeChatSubagentState,
  NativeChatMessage
} from '../../../../shared/native-chat/native-chat-types'

import { projectStructuredItemsToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'

import {
  foldStructuredAgentSubagentRoster,
  NO_STRUCTURED_AGENT_SUBAGENT_ROSTER
} from '../../../../shared/agent-session/view/structured-agent-session-subagent-roster'

import { NativeChatMessageList } from './NativeChatMessageList'

import { session, stubLayout } from './native-chat-windowing-test-harness'

import {
  TRANSCRIPT_LENGTH,
  list,
  marker,
  scrollTranscript,
  stubLayout as materialRailStubLayout,
  windowState
} from './NativeChatMessageList.windowing-test-support'

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

  const renderList = () => render(listOf('completed'))

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

    it("shows the conversation and none of the subagent's words until its entry opens them", () => {
      renderList()
      expect(screen.getByText('Delegated; nothing to fix.')).toBeInTheDocument()
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))
      fireEvent.click(screen.getByRole('button', { name: /explore the lane/, expanded: false }))

      expect(screen.getAllByText('explore the lane')).toHaveLength(1)
      const entry = screen.getByRole('button', { name: /explore the lane/, expanded: true })
      const said = screen.getByText('The PR is CLEAN.')
      expect(entry.compareDocumentPosition(said)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(said.compareDocumentPosition(screen.getByText('Delegated; nothing to fix.'))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      )

      fireEvent.click(entry)
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()
      expect(
        screen.getByRole('button', { name: /explore the lane/, expanded: false })
      ).toBeVisible()
    })

    // happy-dom has no layout; assert margins so controls cannot overhang the section border into the next row.
    it("keeps a section row's controls inside the row that carries the section's border", () => {
      renderList()
      fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))
      fireEvent.click(screen.getByRole('button', { name: /explore the lane/, expanded: false }))
      const controlsOf = (text: string): HTMLElement => {
        const row = screen.getByText(text).closest<HTMLElement>('.group')
        expect(row).not.toBeNull()
        return within(row!).getByRole('button', { name: 'Scroll this message to top' })
          .parentElement!
      }

      const sectionControls = controlsOf('The PR is CLEAN.')
      expect(sectionControls.closest('.border-l-2')).not.toBeNull()
      expect(sectionControls).not.toHaveClass('-mb-5')
      expect(controlsOf('Delegated; nothing to fix.')).toHaveClass('-mb-5')
    })

    it("draws an open agent's rows between its entry and the next one", () => {
      const agents = [
        { id: 'task-a', label: 'lane a', state: 'completed' as const },
        { id: 'task-b', label: 'lane b', state: 'completed' as const },
        { id: 'task-c', label: 'lane c', state: 'completed' as const }
      ]
      const items = [
        itemsWith('completed', false)[0]!,
        journalItem(
          'spawn',
          {
            kind: 'message',
            role: 'system',
            blocks: [{ type: 'subagent-group', groupId: 'group-1', agents }]
          },
          2
        ),
        ...agents.map(({ id, label }, index) =>
          journalItem(
            `${id}-said`,
            {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: `Read ${label}.` }]
            },
            3 + index,
            { agentId: id, producerKind: 'agent' }
          )
        )
      ]
      render(
        <NativeChatMessageList
          session={session(projectStructuredItemsToNativeChat(items))}
          journalItems={items}
          isWorking={false}
          expandSignal={false}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /Ran 3 subagents/ }))
      fireEvent.click(screen.getByRole('button', { name: /lane b/ }))

      const order = [
        screen.getByRole('button', { name: /lane a/, expanded: false }),
        screen.getByRole('button', { name: /lane b/, expanded: true }),
        screen.getByText('Read lane b.'),
        screen.getByRole('button', { name: /lane c/, expanded: false })
      ]
      for (const [index, node] of order.slice(1).entries()) {
        expect(order[index]!.compareDocumentPosition(node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      }
      expect(screen.queryByText('Read lane a.')).toBeNull()
      expect(screen.getAllByText(/^lane [abc]$/)).toHaveLength(3)
    })

    it("shows the subagent's patch without opening its diagnostic section", () => {
      vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {})
      renderList()
      expect(screen.queryByRole('button', { name: /^Edited .*a\.ts(?:\s|$)/ })).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))

      expect(screen.getByText('Edited')).toBeInTheDocument()
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()
      expect(screen.getByRole('button', { name: /Ran 1 subagent/, expanded: false })).toBeVisible()
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
      expect(rollups.map((rollup) => rollup.textContent)).toEqual([
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

    it('reveals an edit under a roster list the reader closed', () => {
      vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {})
      renderList()
      fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))
      fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))

      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))

      expect(screen.getByText('Edited')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Ran 1 subagent/, expanded: false })).toBeVisible()
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
      expect(screen.getByRole('button', { name: /Ran 1 subagent/, expanded: false })).toBeVisible()

      fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))
      expect(screen.getByText('The PR is CLEAN.')).toBeInTheDocument()
    })

    it('opens a working subagent while the session waits on it, and closes it once the parent moves on', () => {
      const { rerender } = render(listOf('working', true))
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()
      expect(screen.getByRole('button', { name: /Ran 1 subagent/, expanded: false })).toBeVisible()
      expect(screen.getAllByText('explore the lane')).toHaveLength(1)
      rerender(listOf('working'))
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()
      expect(screen.getByRole('button', { name: /Kicked off 1 subagent/ })).toBeInTheDocument()
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

    it("does not replay a working subagent's streaming reply when its section reopens", () => {
      const items = itemsWith('working', false).filter((next) => next.itemId !== 'child-edit')
      render(
        <NativeChatMessageList
          session={session(projectStructuredItemsToNativeChat(items))}
          journalItems={items}
          isWorking
          expandSignal={false}
        />
      )
      expect(screen.getByText('The PR is CLEAN.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /explore the lane/, expanded: true }))
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()

      // Back as the transcript's last, still-streaming row: already read, so it shows whole at once.
      fireEvent.click(screen.getByRole('button', { name: /explore the lane/, expanded: false }))
      expect(screen.getByText('The PR is CLEAN.')).toBeInTheDocument()
    })

    it('names a section from the client roster when its roster row is not loaded', () => {
      const items = itemsWith('completed', true)
      const loaded = items.filter((next) => next.itemId !== 'spawn')
      render(
        <NativeChatMessageList
          session={session(projectStructuredItemsToNativeChat(loaded))}
          journalItems={loaded}
          subagentRoster={foldStructuredAgentSubagentRoster(
            NO_STRUCTURED_AGENT_SUBAGENT_ROSTER,
            items
          )}
          isWorking={false}
          expandSignal={false}
        />
      )
      expect(
        screen.getByRole('button', { name: /explore the lane/, expanded: false })
      ).toBeVisible()
    })
  })
}

{
  const stubLayout = materialRailStubLayout

  // Rail jumps borrow the diff-reveal pin; release it after scrolling so later renders cannot repeat or outrank navigation.
  describe('jumping to a message from the rail', () => {
    afterEach(cleanup)
    let restoreLayout = (): void => {}
    beforeEach(() => {
      restoreLayout = stubLayout()
    })
    afterEach(() => {
      restoreLayout()
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    function userMarker(index: number): NativeChatMessage {
      return {
        id: `message-${index}`,
        role: 'user',
        blocks: [{ type: 'text', text: `prompt-${index}` }],
        timestamp: index + 1,
        source: 'transcript'
      }
    }

    const conversation = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
      index % 10 === 0 ? userMarker(index) : marker(index)
    )

    function jumpToFirstPrompt(): void {
      fireEvent.click(screen.getByRole('button', { name: 'prompt-0' }))
      act(() => {
        vi.advanceTimersByTime(300)
      })
    }

    it('scrolls once for a selection, not again on every later render', () => {
      vi.useFakeTimers()
      const scrollTo = vi.fn()
      vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
      const { container, rerender } = render(list(conversation))
      scrollTranscript(container, 6000)

      jumpToFirstPrompt()
      expect(scrollTo).toHaveBeenCalled()

      // Streaming rerenders must not replay a consumed jump after the reader leaves.
      scrollTo.mockClear()
      rerender(list(conversation))
      rerender(list(conversation))
      expect(scrollTo).not.toHaveBeenCalled()
    })

    it('releases the pin once the jump is spent', () => {
      vi.useFakeTimers()
      const scrollTo = vi.fn()
      vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
      const { container } = render(list(conversation))
      scrollTranscript(container, 6000)

      jumpToFirstPrompt()
      expect(scrollTo).toHaveBeenCalled()

      // Release the pin after issuing the scroll so it cannot retain the row or outrank a diff reveal.
      expect(windowState(container).indexes).not.toContain(0)
    })
  })
}
