// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { renderHook } from '@testing-library/react'
import {
  AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/agent-session-create-capabilities'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { useAppStore } from '@/store'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../../shared/runtime-session-contracts'
import { launchNativeChatFork } from './native-chat-fork-launch'
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

const host = vi.hoisted(
  (): {
    capabilities: Set<string>
    contacts: Set<() => void>
  } => ({
    capabilities: new Set<string>(),
    contacts: new Set<() => void>()
  })
)
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: (_environmentId: string, capability: string) =>
    Promise.resolve(host.capabilities.has(capability))
}))
vi.mock('@/runtime/hosts/connections/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (_environmentId: string, listener: () => void) => {
    host.contacts.add(listener)
    return () => host.contacts.delete(listener)
  }
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

  it('forks through a reply that ends on an inline visual', () => {
    const visual = {
      ...row('reply-visual', 'assistant', 10_001),
      blocks: [
        { type: 'text' as const, text: 'Here is the trend.\n\n::orca-visual{file="trend.html"}' }
      ]
    }
    const { input, latestTurnKey } = conversation(
      [finished(0), { ask: 'ask-1', replies: [visual] }],
      false
    )

    expect(
      buildNativeChatTranscript({
        ...input,
        forkOffer: offer('checkpoint', new Set(['reply-0', 'reply-visual']), latestTurnKey)
      }).forkPoint
    ).toEqual({ kind: 'ready', throughItemId: 'reply-visual' })
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

it('offers inherited ancestor replies in a fork of a fork while the child is running', () => {
  const { input, latestTurnKey } = conversation(
    [
      { ask: 'older-user', replies: [row('legacy:opencode:source:reply-0', 'assistant', 1)] },
      {
        ask: 'inherited-user',
        replies: [row('legacy:opencode:parent-fork:reply-1', 'assistant', 3)]
      },
      { ask: 'own-user', replies: [row('legacy:opencode:child:reply-2', 'assistant', 6)] }
    ],
    true
  )
  const inventory = nativeChatForkInventory([
    {
      itemId: 'legacy:opencode:source:reply-0',
      sequence: 1,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'older copied reply' }]
      }
    },
    {
      itemId: 'legacy:opencode:parent-fork:reply-1',
      sequence: 3,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'copied' }] }
    },
    {
      itemId: 'orca:forked-from',
      sequence: 4,
      body: { kind: 'status', text: 'Forked from source', presentation: 'forked-from' }
    },
    {
      itemId: 'legacy:opencode:child:reply-2',
      sequence: 6,
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
  const olderRow = {
    message: row('legacy:opencode:source:reply-0', 'assistant', 1),
    inSubagentSection: false,
    turnWorking: false,
    inLatestTurn: false
  }
  expect(nativeChatRowOffersFork(olderRow, chat)).toBe(true)
  expect(
    nativeChatRowOffersFork(olderRow, {
      ...chat,
      support: { kind: 'known', fork: 'tip' }
    })
  ).toBe(false)
  // Checkpoint providers still offer earlier inherited replies without original-tip support.
  expect(
    nativeChatRowOffersFork(olderRow, {
      ...chat,
      support: { kind: 'known', fork: 'checkpoint' }
    })
  ).toBe(true)
  expect(
    buildNativeChatTranscript({
      ...input,
      forkOffer: { chat: { ...chat, support: { kind: 'known', fork: 'tip' } }, latestTurnKey }
    }).forkPoint
  ).toEqual({ kind: 'reply-running' })
  expect(
    buildNativeChatTranscript({ ...input, forkOffer: { chat, latestTurnKey } }).forkPoint
  ).toEqual({ kind: 'ready', throughItemId: 'legacy:opencode:parent-fork:reply-1' })
  expect(
    buildNativeChatTranscript({
      ...input,
      forkOffer: { chat: { ...chat, contextFloorSequence: 4 }, latestTurnKey }
    }).forkPoint
  ).toEqual({ kind: 'reply-running' })
})

it('carries current target-host proof into desktop response and side-chat offers', async () => {
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
      itemId: 'inherited-user',
      sequence: 0,
      revision: 1,
      observedAt: 0,
      body: { kind: 'message', role: 'user', blocks: [] }
    },
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
      itemId: 'own-user',
      sequence: 3,
      revision: 1,
      observedAt: 3,
      body: { kind: 'message', role: 'user', blocks: [] }
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
  publishStatus('verified')
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
  await act(async () => {})
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
  await act(async () => {
    publishStatus('verified')
    host.contacts.forEach((listener) => listener())
  })
  side.rerender()
  expect(responseOffered()).toBe(true)
  expect(sidePoint()).toEqual({ kind: 'ready', throughItemId: 'legacy:opencode:source:reply-1' })

  await act(async () => publishStatus('checking'))
  side.rerender()
  expect(responseOffered()).toBe(false)
  expect(sidePoint()).toEqual({ kind: 'reply-running' })
  expect(
    nativeChatRowOffersFork(
      { message: own, inSubagentSection: false, turnWorking: false, inLatestTurn: true },
      pane.result.current!
    )
  ).toBe(true)
  await act(async () => publishStatus('unavailable'))
  side.rerender()
  expect(responseOffered()).toBe(false)
  await act(async () => publishStatus('verified'))
  side.rerender()
  expect(responseOffered()).toBe(true)
  expect(sidePoint()).toEqual({ kind: 'ready', throughItemId: 'legacy:opencode:source:reply-1' })

  vi.mocked(launchNativeChatFork).mockResolvedValue({})
  await act(async () => {
    await pane.result.current!.rowAction.request(copied.id, { question: 'Explain' })
  })
  expect(launchNativeChatFork).toHaveBeenLastCalledWith(
    expect.objectContaining({
      forkFrom: { sessionId: 'child', throughItemId: 'legacy:opencode:source:reply-1' },
      forkRequiresInheritedOriginal: true,
      side: { question: 'Explain' }
    })
  )
  await act(async () => {
    await pane.result.current!.rowAction.request(own.id)
  })
  expect(launchNativeChatFork).toHaveBeenLastCalledWith(
    expect.objectContaining({ forkRequiresInheritedOriginal: false })
  )

  host.capabilities.delete(AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY)
  await act(async () => {
    publishStatus('verified')
    host.contacts.forEach((listener) => listener())
  })
  side.rerender()
  expect(responseOffered()).toBe(false)
  expect(sidePoint()).toEqual({ kind: 'reply-running' })
})

function publishStatus(verification: 'verified' | 'checking' | 'unavailable') {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only runtime identity/capabilities are read by these hooks.
  const status = { runtimeId: 'runtime-a', capabilities: [...host.capabilities] } as RuntimeStatus
  useAppStore.setState({
    runtimeStatusByEnvironmentId: new Map([
      [
        'paired-host',
        {
          ...runtimeEnvironmentStatusFromSnapshot({
            environmentId: 'paired-host',
            pairingRevision: 1,
            sequence: 1,
            checkedAt: 1,
            status,
            verification,
            transport: verification === 'verified' ? 'ready' : 'disconnected'
          }),
          connectionGeneration: 1,
          hostContactEpoch: 1
        }
      ]
    ])
  })
}
