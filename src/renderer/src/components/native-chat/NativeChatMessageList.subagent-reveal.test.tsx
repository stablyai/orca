// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { createRef, useCallback, useState } from 'react'
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
import type { StructuredAgentSubagentRoster } from '../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { NativeChatSubagentEntry } from '../../../../shared/native-chat/native-chat-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import { session, stubLayout } from './native-chat-windowing-test-harness'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'

function journalItem(
  itemId: string,
  body: AgentJournalItemBody,
  sequence: number,
  linkage: AgentJournalProducerLinkage = {}
): AgentJournalRenderItem {
  return { itemId, body, sequence, observedAt: sequence * 1000, revision: 1, ...linkage }
}

const say = (
  itemId: string,
  role: 'user' | 'assistant',
  text: string,
  sequence: number,
  agentId?: string
): AgentJournalRenderItem =>
  journalItem(
    itemId,
    { kind: 'message', role, blocks: [{ type: 'text', text }] },
    sequence,
    agentId === undefined ? {} : { agentId, producerKind: 'agent' }
  )

const spawn = (
  itemId: string,
  agents: NativeChatSubagentEntry[],
  sequence: number,
  agentId?: string
): AgentJournalRenderItem =>
  journalItem(
    itemId,
    {
      kind: 'message',
      role: 'system',
      blocks: [{ type: 'subagent-group', groupId: `group-${itemId}`, agents }]
    },
    sequence,
    agentId === undefined ? {} : { agentId, producerKind: 'agent' }
  )

const agent = (id: string, label: string): NativeChatSubagentEntry => ({
  id,
  label,
  state: 'working'
})

function rosterOf(item: AgentJournalRenderItem): StructuredAgentSubagentRoster {
  const block = item.body.kind === 'message' ? item.body.blocks[0] : undefined
  const agents = block?.type === 'subagent-group' ? block.agents : []
  return new Map(
    agents.map((entry) => [
      entry.id,
      {
        entry,
        rosterItemId: item.itemId,
        rosterPosition: { sequence: item.sequence, index: 0 },
        rosterRevision: 1
      }
    ])
  )
}

/** Pages older items in on demand; the host's roster names every spawn, loaded or not. */
function Transcript({
  items,
  initiallyLoaded = items.length,
  roster,
  loadEarlier: onLoadEarlier,
  handle
}: {
  items: AgentJournalRenderItem[]
  initiallyLoaded?: number
  roster?: StructuredAgentSubagentRoster
  loadEarlier?: () => void
  handle: React.Ref<NativeChatMessageListHandle>
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(initiallyLoaded)
  const loadEarlier = useCallback(async (): Promise<NativeChatOlderPageResult> => {
    onLoadEarlier?.()
    await Promise.resolve()
    setLoaded((current) => Math.min(items.length, current + 2))
    return 'applied'
  }, [items.length, onLoadEarlier])
  const shown = items.slice(items.length - loaded)
  return (
    <NativeChatMessageList
      ref={handle}
      session={{
        ...session(projectStructuredItemsToNativeChat(shown)),
        hasMore: loaded < items.length,
        loadEarlier
      }}
      journalItems={shown}
      subagentRoster={roster}
      isWorking={false}
      expandSignal={false}
    />
  )
}

async function reveal(
  handle: React.RefObject<NativeChatMessageListHandle | null>,
  agentId: string
): Promise<void> {
  await act(async () => {
    handle.current?.revealSubagent(agentId)
    await Promise.resolve()
  })
}

describe('revealing a subagent named by the agents strip', () => {
  let restoreLayout = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout()
  })
  afterEach(() => {
    cleanup()
    restoreLayout()
    vi.restoreAllMocks()
  })

  it("opens a closed roster and the child's section, past a last row that draws nothing", async () => {
    const items = [
      say('ask', 'user', 'Review it', 1),
      spawn('spawn', [agent('task-a', 'lane a'), agent('task-b', 'lane b')], 2),
      say('a-said', 'assistant', 'Read lane a.', 3, 'task-a'),
      say('b-said', 'assistant', 'Read lane b.', 4, 'task-b'),
      journalItem('b-stub', { kind: 'message', role: 'assistant', blocks: [] }, 5, {
        agentId: 'task-b',
        producerKind: 'agent'
      }),
      say('answer', 'assistant', 'Delegated.', 6)
    ]
    const handle = createRef<NativeChatMessageListHandle>()
    render(<Transcript items={items} handle={handle} />)
    expect(screen.queryByText('Read lane b.')).toBeNull()

    await reveal(handle, 'task-b')

    await waitFor(() => expect(screen.getByText('Read lane b.')).toBeInTheDocument())
    expect(screen.queryByText('Read lane a.')).toBeNull()
    expect(screen.getByRole('button', { name: /lane b/, expanded: true })).toBeVisible()
  })

  it('opens the ancestors of a nested child', async () => {
    const items = [
      say('ask', 'user', 'Review it', 1),
      spawn('spawn', [agent('task-a', 'lane a')], 2),
      say('a-said', 'assistant', 'Starting a helper.', 3, 'task-a'),
      spawn('a-spawn', [agent('task-n', 'helper')], 4, 'task-a'),
      journalItem(
        'n-said',
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Helper found it.' }]
        },
        5,
        { agentId: 'task-n', parentAgentId: 'task-a', producerKind: 'agent' }
      ),
      say('answer', 'assistant', 'Delegated.', 6)
    ]
    const handle = createRef<NativeChatMessageListHandle>()
    render(<Transcript items={items} handle={handle} />)

    await reveal(handle, 'task-n')

    await waitFor(() => expect(screen.getByText('Helper found it.')).toBeInTheDocument())
    expect(screen.getByText('Starting a helper.')).toBeInTheDocument()
  })

  it('opens a roster whose child has no activity yet and shows its entry', async () => {
    const roster = spawn('spawn', [agent('grok-1', 'search the docs')], 2)
    const items = [
      say('ask', 'user', 'Look it up', 1),
      roster,
      say('answer', 'assistant', 'Started.', 3)
    ]
    const handle = createRef<NativeChatMessageListHandle>()
    render(<Transcript items={items} roster={rosterOf(roster)} handle={handle} />)
    expect(
      screen.getByRole('button', { name: /Kicked off 1 subagent/, expanded: false })
    ).toBeVisible()
    expect(screen.queryByText('search the docs')).toBeNull()

    await reveal(handle, 'grok-1')

    await waitFor(() => expect(screen.getByText('search the docs')).toBeInTheDocument())
    expect(
      screen.getByRole('button', { name: /Kicked off 1 subagent/, expanded: true })
    ).toBeVisible()
  })

  it('pages older history until the spawn loads, and a reader scroll abandons the paging', async () => {
    const roster = spawn('spawn', [agent('grok-1', 'search the docs')], 2)
    const items = [
      say('ask', 'user', 'Look it up', 1),
      roster,
      ...Array.from({ length: 6 }, (_, index) =>
        say(`later-${index}`, 'assistant', `Later ${index}.`, 3 + index)
      )
    ]
    const loads = vi.fn()
    const handle = createRef<NativeChatMessageListHandle>()
    const { unmount } = render(
      <Transcript
        items={items}
        initiallyLoaded={2}
        roster={rosterOf(roster)}
        loadEarlier={loads}
        handle={handle}
      />
    )

    await reveal(handle, 'grok-1')

    await waitFor(() => expect(screen.getByText('search the docs')).toBeInTheDocument())
    expect(loads).toHaveBeenCalledTimes(3)
    unmount()

    const abandoned = vi.fn()
    render(
      <Transcript
        items={items}
        initiallyLoaded={2}
        roster={rosterOf(roster)}
        loadEarlier={abandoned}
        handle={handle}
      />
    )
    await act(async () => {
      handle.current?.revealSubagent('grok-1')
      fireEvent.wheel(screen.getByLabelText('Conversation'), { deltaY: -40 })
      await Promise.resolve()
    })
    // Long enough for the three pages an unabandoned reveal needs to land.
    await act(async () => {
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve()
      }
    })
    expect(abandoned.mock.calls.length).toBeLessThanOrEqual(1)
    expect(screen.queryByText('search the docs')).toBeNull()
  })

  it('does not page for a child spawned before the latest /clear', async () => {
    const roster = spawn('spawn', [agent('task-1', 'old work')], 2)
    const items = [
      say('ask', 'user', 'Start it', 1),
      roster,
      journalItem(
        'clear',
        {
          kind: 'status',
          text: 'Context cleared',
          presentation: 'context-cleared',
          contextClear: { operationId: 'clear-4', afterFence: 1, clearedAt: 4 }
        },
        4
      ),
      say('after-1', 'user', 'New topic', 5),
      say('after-2', 'assistant', 'Sure.', 6)
    ]
    const loads = vi.fn()
    const handle = createRef<NativeChatMessageListHandle>()
    render(
      <Transcript
        items={items}
        initiallyLoaded={3}
        roster={rosterOf(roster)}
        loadEarlier={loads}
        handle={handle}
      />
    )

    await reveal(handle, 'task-1')

    expect(loads).not.toHaveBeenCalled()
  })
})
