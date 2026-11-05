// @vitest-environment happy-dom
import { memo } from 'react'
import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { useNativeChatFork } from './use-native-chat-fork'
import { NativeChatForkContext } from './native-chat-fork-context'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from './NativeChatTranscriptRow'
import type { NativeChatMessageSlot } from './native-chat-transcript-slots'
import type { MessageRowProps } from './NativeChatMessageRow'

const renders = vi.hoisted(() => new Map<string, number>())
const forkProps = vi.hoisted(() => new Map<string, unknown>())
// The memoized message row is what a fork offer re-renders; count its commits per response.
vi.mock('./NativeChatMessageRow', async () => {
  const { memo: memoize } = await import('react')
  return {
    MessageRow: memoize(function CountedMessageRow(props: MessageRowProps) {
      renders.set(props.message.id, (renders.get(props.message.id) ?? 0) + 1)
      forkProps.set(props.message.id, props.fork)
      return null
    })
  }
})
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))
vi.mock('@/runtime/use-host-structured-agent', () => ({
  useHostStructuredAgent: () => ({ agent: 'claude', capabilities: { fork: 'checkpoint' } })
}))
vi.mock('./native-chat-fork-launch', () => ({
  launchNativeChatFork: vi.fn(),
  nativeChatForkSurfaceAddress: vi.fn()
}))

function reply(id: string, sequence: number, text: string): AgentJournalRenderItem {
  return {
    itemId: id,
    sequence,
    revision: 1,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

function slot(item: AgentJournalRenderItem): NativeChatMessageSlot {
  const message: NativeChatMessage = {
    id: item.itemId,
    role: 'assistant',
    blocks: item.body.kind === 'message' ? item.body.blocks : [],
    timestamp: item.observedAt,
    source: 'transcript',
    journalPosition: { sequence: item.sequence, index: 0 }
  }
  return {
    kind: 'message',
    message,
    turnKey: `turn-${item.itemId}`,
    activeTurnIsWorking: false,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    turnDiff: undefined,
    subagentRoster: undefined,
    depth: 0,
    estimatedHeight: 40
  }
}

const rowContext: NativeChatTranscriptRowContext = {
  expandSignal: false,
  revealedDiff: null,
  taskListPredecessors: new Map(),
  expandedTurnIds: new Set(),
  allowFileUriLinks: false,
  onToggleExpandedTurn: () => {},
  subagentDisclosure: { setSectionOpen: () => {}, setRosterOpen: () => {} },
  onScrollMessageToTop: () => {},
  onRevealDiff: () => {}
}

/** The pane's production fork hook feeding production transcript rows, as a streaming chat does. */
const Transcript = memo(function Transcript({
  items,
  slots
}: {
  items: readonly AgentJournalRenderItem[]
  slots: readonly NativeChatMessageSlot[]
}) {
  const fork = useNativeChatFork({
    sessionId: 'claude_source',
    tabId: 'tab-source',
    agent: 'claude',
    target: { kind: 'local' },
    worktreeId: 'wt-1',
    items,
    epoch: 'epoch-1',
    contextFloor: undefined,
    sessionForkSupport: 'supported'
  })
  return (
    <NativeChatForkContext.Provider value={fork}>
      {slots.map((entry) => (
        <NativeChatTranscriptRow key={entry.message.id} slot={entry} context={rowContext} />
      ))}
    </NativeChatForkContext.Provider>
  )
})

it('re-renders no settled response while a commit leaves the forkable set unchanged', async () => {
  const first = reply('reply-1', 1, 'First.')
  const second = reply('reply-2', 2, 'Second.')
  const slots = [slot(first), slot(second)]
  // A streaming status row lands after the responses; the forkable set is the same two ids.
  const streaming = (text: string): AgentJournalRenderItem => ({
    itemId: 'live-status',
    sequence: 3,
    revision: text.length,
    observedAt: 3,
    body: { kind: 'status', text }
  })
  const view = render(<Transcript items={[first, second, streaming('a')]} slots={slots} />)
  await act(async () => {})
  renders.clear()

  await act(async () => {
    view.rerender(<Transcript items={[first, second, streaming('ab')]} slots={slots} />)
  })
  await act(async () => {
    view.rerender(<Transcript items={[first, second, streaming('abc')]} slots={slots} />)
  })

  expect(renders.get('reply-1') ?? 0).toBe(0)
  expect(renders.get('reply-2') ?? 0).toBe(0)
})

it('still offers a newly finished response without re-rendering the settled ones', async () => {
  const first = reply('reply-1', 1, 'First.')
  // The projection keeps a settled row's slot and message objects across commits.
  const firstSlot = slot(first)
  const view = render(<Transcript items={[first]} slots={[firstSlot]} />)
  await act(async () => {})
  const firstFork = forkProps.get('reply-1')
  renders.clear()

  const second = reply('reply-2', 2, 'Second.')
  await act(async () => {
    view.rerender(<Transcript items={[first, second]} slots={[firstSlot, slot(second)]} />)
  })

  expect(renders.get('reply-1') ?? 0).toBe(0)
  expect(forkProps.get('reply-1')).toBe(firstFork)
  expect(renders.get('reply-2')).toBe(1)
  expect(forkProps.get('reply-2')).toBeDefined()
})
