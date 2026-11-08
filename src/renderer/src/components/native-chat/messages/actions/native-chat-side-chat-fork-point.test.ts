// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderHook } from '@testing-library/react'
import {
  AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/agent-session-create-capabilities'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { useNativeChatFork } from './use-native-chat-fork'
import { useNativeChatSideChatForkOffer } from './use-native-chat-side-chat'
import {
  NativeChatForkContext,
  NativeChatSideChatForkPointContext
} from './native-chat-fork-context'
import {
  nativeChatRowOffersFork,
  nativeChatForkInventory
} from '../../../../../../shared/native-chat/native-chat-fork-offer'
import { describe, expect, it, vi } from 'vitest'

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptSlotsInput } from '../../conversation/slots/native-chat-transcript-input'
import { buildNativeChatTranscript } from '../../conversation/slots/native-chat-transcript-slots'

const host = vi.hoisted(() => ({ capabilities: new Set<string>() }))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: (_target: unknown, capability: string) =>
    host.capabilities.has(capability) ? 'supported' : 'unsupported'
}))
vi.mock('@/runtime/native-chat/agent-catalogs/use-host-structured-agent', () => ({
  useHostStructuredAgent: () => ({ capabilities: { fork: 'tip' } })
}))
vi.mock('@/components/native-chat/messages/actions/native-chat-fork-launch', () => ({
  launchNativeChatFork: vi.fn(),
  nativeChatForkSurfaceAddress: vi.fn()
}))
vi.mock('@/components/native-chat/messages/actions/native-chat-side-chat-placement', () => ({
  beginNativeChatSideChatPlacement: vi.fn()
}))

function row(id: string, role: 'user' | 'assistant', sequence: number): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text: id }],
    timestamp: sequence,
    source: 'transcript',
    journalPosition: { sequence, index: 0 }
  }
}

/** `turns` finished turns, then a running one, laid out as the transcript draws them. */
function conversation(turns: { ask: string; replies: NativeChatMessage[] }[], working: boolean) {
  const messages = turns.flatMap((turn, index) => [
    row(turn.ask, 'user', index * 10_000),
    ...turn.replies
  ])
  const turnKeys = turns.flatMap((turn) => [turn.ask, ...turn.replies.map(() => turn.ask)])
  const latestTurnKey = turns.at(-1)?.ask
  const input: NativeChatTranscriptSlotsInput = {
    messages,
    turnKeys,
    liveTurnKey: working ? latestTurnKey : undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(turns.map((turn) => turn.ask)),
    isWorking: working,
    lifecycleWorking: false
  }
  return { input, latestTurnKey, rootRows: messages.length }
}

function offer(
  fork: 'checkpoint' | 'tip',
  forkableItemIds: ReadonlySet<string>,
  latestTurnKey: string | undefined,
  contextFloorSequence = 0
) {
  return {
    chat: { support: { kind: 'known', fork }, contextFloorSequence, forkableItemIds },
    latestTurnKey
  } as const
}

describe('the side chat fork point the transcript finds while laying out', () => {
  const finished = (index: number) => ({
    ask: `ask-${index}`,
    replies: [row(`reply-${index}`, 'assistant', index * 10_000 + 1)]
  })

  it('forks a running chat through its last finished response, or waits at a tip', () => {
    const live = { ask: 'ask-live', replies: [row('reply-live', 'assistant', 99_001)] }
    const forkable = new Set(['reply-1', 'reply-live'])
    const { input, latestTurnKey } = conversation([finished(1), live], true)

    expect(
      buildNativeChatTranscript({
        ...input,
        forkOffer: offer('checkpoint', forkable, latestTurnKey)
      }).forkPoint
    ).toEqual({ kind: 'ready', throughItemId: 'reply-1' })
    expect(
      buildNativeChatTranscript({ ...input, forkOffer: offer('tip', forkable, latestTurnKey) })
        .forkPoint
    ).toEqual({ kind: 'reply-running' })

    const done = conversation([finished(1), live], false)
    expect(
      buildNativeChatTranscript({
        ...done.input,
        forkOffer: offer('tip', forkable, done.latestTurnKey)
      }).forkPoint
    ).toEqual({ kind: 'ready', throughItemId: 'reply-live' })
  })

  it('has nothing to fork above a /clear', () => {
    const { input, latestTurnKey } = conversation([finished(1)], false)

    expect(
      buildNativeChatTranscript({
        ...input,
        forkOffer: offer('checkpoint', new Set(['reply-1']), latestTurnKey, 50_000)
      }).forkPoint
    ).toEqual({ kind: 'no-reply' })
  })
})

it('offers the inherited source tip while a later child response is running', () => {
  const { input, latestTurnKey } = conversation(
    [
      { ask: 'inherited-user', replies: [row('legacy:opencode:source:reply-1', 'assistant', 1)] },
      { ask: 'own-user', replies: [row('legacy:opencode:child:reply-2', 'assistant', 4)] }
    ],
    true
  )
  const inventory = nativeChatForkInventory([
    {
      itemId: 'legacy:opencode:source:reply-1',
      sequence: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'copied' }] }
    },
    {
      itemId: 'orca:forked-from',
      sequence: 1,
      body: { kind: 'status', text: 'Forked from source', presentation: 'forked-from' }
    },
    {
      itemId: 'legacy:opencode:child:reply-2',
      sequence: 4,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'local partial' }]
      }
    }
  ])
  const chat = {
    support: { kind: 'known', fork: 'tip', inheritedOriginal: true },
    contextFloorSequence: 0,
    ...inventory
  } as const
  expect(
    buildNativeChatTranscript({
      ...input,
      forkOffer: { chat: { ...chat, support: { kind: 'known', fork: 'tip' } }, latestTurnKey }
    }).forkPoint
  ).toEqual({ kind: 'reply-running' })
  expect(
    buildNativeChatTranscript({ ...input, forkOffer: { chat, latestTurnKey } }).forkPoint
  ).toEqual({ kind: 'ready', throughItemId: 'legacy:opencode:source:reply-1' })
  expect(
    buildNativeChatTranscript({
      ...input,
      forkOffer: { chat: { ...chat, contextFloorSequence: 2 }, latestTurnKey }
    }).forkPoint
  ).toEqual({ kind: 'reply-running' })
})

it('carries target-host original-fork support into desktop response and side-chat offers', () => {
  const copied = row('legacy:opencode:source:reply-1', 'assistant', 1)
  const own = row('legacy:opencode:child:reply-2', 'assistant', 4)
  const { input, latestTurnKey } = conversation(
    [
      { ask: 'inherited-user', replies: [copied] },
      { ask: 'own-user', replies: [own] }
    ],
    true
  )
  const items: AgentJournalRenderItem[] = [
    {
      itemId: copied.id,
      sequence: 1,
      revision: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'assistant', blocks: copied.blocks }
    },
    {
      itemId: 'orca:forked-from',
      sequence: 1,
      revision: 1,
      observedAt: 1,
      body: { kind: 'status', presentation: 'forked-from', text: 'Forked from source' }
    },
    {
      itemId: own.id,
      sequence: 4,
      revision: 1,
      observedAt: 4,
      body: { kind: 'message', role: 'assistant', blocks: own.blocks }
    }
  ]
  host.capabilities = new Set([AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY])
  const pane = renderHook(() =>
    useNativeChatFork({
      sessionId: 'child',
      tabId: 'tab',
      agent: 'opencode',
      target: { kind: 'environment', environmentId: 'paired-host' },
      worktreeId: 'workspace',
      items,
      epoch: 'epoch',
      contextFloor: undefined,
      sessionForkSupport: 'supported'
    })
  )
  const responseOffered = () =>
    nativeChatRowOffersFork(
      {
        message: copied,
        inSubagentSection: false,
        turnWorking: false,
        inLatestTurn: false
      },
      { ...pane.result.current!, support: pane.result.current!.rowAction.support }
    )
  const side = renderHook(() => useNativeChatSideChatForkOffer(latestTurnKey), {
    wrapper: ({ children }) =>
      createElement(
        NativeChatForkContext.Provider,
        { value: pane.result.current },
        createElement(NativeChatSideChatForkPointContext.Provider, { value: () => {} }, children)
      )
  })
  const sidePoint = () =>
    buildNativeChatTranscript({
      ...input,
      forkOffer: side.result.current
    }).forkPoint
  expect(responseOffered()).toBe(false)
  expect(sidePoint()).toEqual({ kind: 'reply-running' })

  host.capabilities.add(AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY)
  pane.rerender()
  side.rerender()
  expect(responseOffered()).toBe(true)
  expect(sidePoint()).toEqual({ kind: 'ready', throughItemId: 'legacy:opencode:source:reply-1' })

  host.capabilities.delete(AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY)
  pane.rerender()
  side.rerender()
  expect(responseOffered()).toBe(false)
  expect(sidePoint()).toEqual({ kind: 'reply-running' })
})
