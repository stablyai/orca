// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within, act } from '@testing-library/react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'

import type {
  NativeChatSubagentState,
  NativeChatMessage
} from '../../../../shared/native-chat-types'

import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'

import {
  foldStructuredAgentSubagentRoster,
  NO_STRUCTURED_AGENT_SUBAGENT_ROSTER
} from '../../../../shared/structured-agent-session-subagent-roster'

import { NativeChatMessageList } from './NativeChatMessageList'

import { session, stubLayout } from './native-chat-windowing-test-harness'

import {
  TRANSCRIPT_LENGTH,
  list,
  marker,
  scrollTranscript,
  session as materialRailSession,
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

      // Named once: its entry heads its rows, which come before the parent's answer.
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

    // happy-dom has no layout, so the geometry is pinned by the margin that decides it:
    // outside a section a row's controls hang into the gap below it (`-mb-5`), and
    // inside one that overhang would leave them below the section's border, touching
    // the parent's next row.
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

    it("still counts the subagent's edit in the turn, and reveals it inside its section", () => {
      vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {})
      renderList()
      expect(screen.queryByRole('button', { name: /^Edited .*a\.ts(?:\s|$)/ })).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))

      expect(screen.getByText('Edited')).toBeInTheDocument()
      expect(screen.getByText('The PR is CLEAN.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /explore the lane/, expanded: true })).toBeVisible()
    })

    // Rows are grouped by the journal's turn records, so a subagent's edit counts in the
    // turn that was running when it was made: not a send queued mid-turn, whose own turn
    // had not opened, and in a turn keyed to its own record rather than the last prompt.
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
      const rollups = screen.getAllByRole('button', { name: /changed file/ })
      expect(rollups.map((rollup) => rollup.textContent)).toEqual([
        expect.stringMatching(/1 changed file/),
        expect.stringMatching(/1 changed file/)
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

      fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))

      expect(screen.getByText('Edited')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Ran 1 subagent/, expanded: true })).toBeVisible()
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

    it('opens a working subagent while the session waits on it, and closes it once the parent moves on', () => {
      const { rerender } = render(listOf('working', true))
      expect(screen.getByText('The PR is CLEAN.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /explore the lane/, expanded: true })).toBeVisible()
      expect(screen.getAllByText('explore the lane')).toHaveLength(1)
      rerender(listOf('working'))
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()
      // The closed roster still says the agent works.
      expect(screen.getByRole('button', { name: /Kicked off 1 subagent/ })).toBeInTheDocument()
    })

    it("keeps the reader's choice over the frontier, in either direction", () => {
      const { rerender } = render(listOf('working', true))
      fireEvent.click(screen.getByRole('button', { name: /explore the lane/, expanded: true }))
      rerender(listOf('working', true))
      expect(screen.queryByText('The PR is CLEAN.')).toBeNull()

      // Closing the section from its entry left the list open.
      fireEvent.click(screen.getByRole('button', { name: /explore the lane/, expanded: false }))
      rerender(listOf('working'))
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
  const session = materialRailSession
  const stubLayout = materialRailStubLayout

  describe('revealing a diff from a turn rollup', () => {
    afterEach(cleanup)
    let restoreLayout = (): void => {}
    beforeEach(() => {
      restoreLayout = stubLayout({ scrollGeometry: true, offsetChain: true })
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        const row = this.closest<HTMLElement>('[data-index]')
        const scroller = this.closest<HTMLElement>('[data-native-chat-scroll]')
        return new DOMRect(
          0,
          row ? row.offsetTop - (scroller?.scrollTop ?? 0) : 0,
          100,
          this.offsetHeight
        )
      })
    })
    afterEach(() => {
      restoreLayout()
      vi.restoreAllMocks()
    })

    function journalItem(itemId: string, body: AgentJournalItemBody, sequence: number) {
      return { itemId, body, sequence, observedAt: sequence * 1000, revision: 1 }
    }

    const patch = '@@ -1 +1 @@\n-before\n+after'
    const items: AgentJournalRenderItem[] = [
      journalItem(
        'user',
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Edit it' }] },
        1
      ),
      journalItem(
        'diff',
        {
          kind: 'diff',
          path: 'src/a.ts',
          patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length }
        },
        2
      ),
      ...Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
        journalItem(
          `tail-${index}`,
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: `marker-${index}` }]
          },
          index + 3
        )
      )
    ]

    it('lets a rail jump supersede a previously revealed diff', () => {
      const withPrompts = [
        ...items.slice(0, 2),
        journalItem(
          'user-2',
          { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Second prompt' }] },
          3
        ),
        journalItem(
          'user-3',
          { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Third prompt' }] },
          4
        ),
        ...items.slice(2)
      ].map((item, index) => ({ ...item, sequence: index + 1 }))
      const scrollTo = vi.fn()
      vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
      const transcript = (): React.JSX.Element => (
        <NativeChatMessageList
          session={session(projectStructuredItemsToNativeChat(withPrompts))}
          journalItems={withPrompts}
          isWorking={false}
          expandSignal={false}
        />
      )
      const { container, rerender } = render(transcript())
      const selectedTop =
        screen.getByText('Second prompt').closest<HTMLElement>('[data-index]')?.offsetTop ?? 0
      expect(selectedTop).toBeGreaterThan(0)
      fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
      scrollTranscript(container, 6000)
      expect(screen.getByText('Edited')).toBeInTheDocument()
      scrollTo.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Second prompt' }))
      expect(scrollTo.mock.calls).toEqual([
        [{ top: 6000, behavior: 'auto' }],
        [{ top: selectedTop, behavior: 'smooth' }]
      ])
      expect(screen.queryByRole('button', { name: /^Edited .*a\.ts(?:\s|$)/ })).toBeNull()
      scrollTo.mockClear()
      rerender(transcript())
      rerender(transcript())
      expect(scrollTo).not.toHaveBeenCalled()

      scrollTranscript(container, 0)
      scrollTo.mockClear()
      fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
      const diffTop =
        screen.getByText('Edited').closest<HTMLElement>('[data-index]')?.offsetTop ?? 0
      expect(Number.isFinite(diffTop)).toBe(true)
      expect(scrollTo.mock.calls.filter(([options]) => options?.behavior === 'smooth')).toEqual([
        [{ top: diffTop, behavior: 'smooth' }]
      ])
    })
  })

  // The rail borrows the reveal's pin to reach a row the window has left behind.
  // Borrowing the pin means it also has to give it back: the request is what
  // outranks a later reveal, and slots is rebuilt every render, so an effect that
  // merely watched it would re-scroll forever.
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

      // A streaming turn re-renders constantly with the same messages. The jump is
      // spent; nothing here may drag the reader back to the row they left.
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

      // The request is spent as soon as the scroll is issued, so the row it pinned
      // is not held in the window afterwards. A pin still standing here would also
      // still outrank a diff reveal, which shares the same slot.
      expect(windowState(container).indexes).not.toContain(0)
    })
  })
}
