// @vitest-environment happy-dom

// A Codex parent settles, its subagent asks for approval, and the user answers. Every hop is the
// real one: provider translator, deferred sink, durable journal and host status feed, then the
// renderer's status bridge, agent-status store and Activity pipeline. The answer returns the
// session to its own turn's end, so the row must read done, list the ask before the done, and
// leave nothing unread that the user had already read.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../src/shared/agent-session-wire'
import type { AgentJournalItemBody } from '../../src/shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../src/shared/agent-session-journal-item-key'
import type { Tab } from '../../src/shared/tab-types'
import type { AppState } from '../../src/renderer/src/store/types'
import { createCodexJournalTranslator } from '../../src/main/codex/codex-structured-journal-translation'
import { CODEX_COMMAND_APPROVAL_METHOD } from '../../src/main/codex/codex-structured-prompt-replies'
import { createTrackedJournalOpener } from '../../src/main/native-chat/agent-session-journal/journal-store-test-open'
import { createDeferredStructuredAgentSessionEventSink } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-event-sink'
import { StructuredAgentSessionStatusFeed } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-status-feed'
import { indexedStatusFeedSession } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-status-feed-test-session'
import {
  makeRepo,
  makeWorktree
} from '../../src/renderer/src/components/activity/ActivityPrototypePage-test-fixtures'
import {
  activityThreadRowCopy,
  activityThreadStatusId
} from '../../src/renderer/src/components/activity/activity-thread-presentation'
import { countActivityUnread } from '../../src/renderer/src/components/activity/useActivityUnreadCount'
import { useAgentPaneThreads } from '../../src/renderer/src/components/activity/use-agent-pane-threads'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
}

const mocks = vi.hoisted(() => {
  const hoisted: { store: TestStore | null; subscribeStatus: Mock; unsubscribe: Mock } = {
    store: null,
    subscribeStatus: vi.fn(),
    unsubscribe: vi.fn()
  }
  return hoisted
})

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ?? null
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { StructuredAgentSessionStatusBridge } from '../../src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '../../src/renderer/src/runtime/structured-agent-session-status-feed'

const SESSION = 'codex-child-approval'
const CODEX_THREAD = 'thread-parent'
const CODEX_CHILD = 'thread-child'

const structuredTab = {
  id: 'structured-tab-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: SESSION,
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex'
} satisfies Tab

let root: string
const journals = createTrackedJournalOpener()

function store(): TestStore {
  if (!mocks.store) {
    throw new Error('store missing')
  }
  return mocks.store
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetStructuredAgentSessionStatusFeedsForTests()
  mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
  root = await mkdtemp(join(tmpdir(), 'orca-codex-child-approval-'))
  const worktree = makeWorktree()
  store().setState({
    agentStatusByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    retainedAgentsByPaneKey: {},
    testRuntimeOwner: null,
    repos: [makeRepo()],
    worktreesByRepo: { [worktree.repoId]: [worktree] },
    unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
  })
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  resetStructuredAgentSessionStatusFeedsForTests()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** The host half: journal, feed and the real Codex translator over one advancing clock. */
async function openHost() {
  let clock = 10_000
  const tick = (): number => (clock += 1_000)
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'wt-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: CODEX_THREAD }
    },
    now: tick,
    journalDir: join(root, SESSION)
  })
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([
      [SESSION, indexedStatusFeedSession({ journal, child: { phase: 'ready' } })]
    ]),
    getRecord: () => null,
    now: () => 1,
    readBackgroundTasks: () => ({ state: 'monitoring', tasks: [] })
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'renderer', emit: (event) => events.push(event) })
  const deferred = createDeferredStructuredAgentSessionEventSink()
  const publish = (): void => feed.publish(SESSION, journal)
  deferred.bind({ journal, fence: 1, publish })
  const prompts: string[] = []
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    sessionId: SESSION,
    primaryThreadId: () => CODEX_THREAD,
    now: tick,
    bindPromptItemId: (journalItemId) => prompts.push(journalItemId),
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  const on = (threadId: string, method: string, params: Record<string, unknown> = {}) =>
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId,
      method,
      params: { threadId, ...params },
      observedAt: tick()
    })
  const drain = async (): Promise<void> => {
    expect(await deferred.drained()).toEqual({ ok: true })
  }
  /** What the host's answer path commits before it tells Codex. */
  const answer = async (itemId: string): Promise<void> => {
    const identity = parseAgentJournalItemKey(itemId)
    const asked = journal.snapshot().items.find((item) => item.itemId === itemId)?.body
    if (!identity || asked?.kind !== 'approval') {
      throw new Error(`approval ${itemId} missing`)
    }
    const resolved: AgentJournalItemBody = {
      ...asked,
      resolution: {
        state: 'resolved',
        selectedOptionId: 'accept',
        resolvedBy: 'user',
        resolvedAt: tick()
      }
    }
    await journal.appendItem(identity, resolved, { fence: 1 })
    publish()
    translator.resolvePrompt(itemId)
  }
  return { journal, translator, on, drain, answer, prompts, events, tick, close: deferred.close }
}

describe("a Codex subagent's answered approval on the settled parent's Activity row", () => {
  it('reads done, lists the ask before the done, and leaves the answer read', async () => {
    const host = await openHost()
    render(createElement(StructuredAgentSessionStatusBridge))
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    const toRenderer: (event: AgentSessionStatusEvent) => void =
      mocks.subscribeStatus.mock.calls[0]?.[1]
    let forwarded = 0
    const deliver = (): AgentSessionStatusSummary => {
      act(() => {
        for (const event of host.events.slice(forwarded)) {
          toRenderer(event)
        }
      })
      forwarded = host.events.length
      const latest = host.events.findLast((event) => event.type === 'status')
      if (latest?.type !== 'status') {
        throw new Error('status publication missing')
      }
      return latest.session
    }
    const paneKey = (): string => Object.keys(store().getState().agentStatusByPaneKey)[0] ?? ''

    await host.journal.appendItem(
      { provider: 'orca', clientMessageId: 'prompt-1' },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 1 }
    )
    host.on(CODEX_THREAD, 'turn/started', { turn: { id: 'parent-turn' } })
    const spawn = {
      type: 'subAgentActivity',
      id: 'spawn-child',
      kind: 'started',
      agentThreadId: CODEX_CHILD,
      agentPath: '/root/review'
    }
    host.on(CODEX_THREAD, 'item/started', { turnId: 'parent-turn', item: spawn })
    host.on(CODEX_THREAD, 'item/completed', { turnId: 'parent-turn', item: spawn })
    host.on(CODEX_CHILD, 'turn/started', { turn: { id: 'child-turn' } })
    host.on(CODEX_THREAD, 'turn/completed', { turn: { id: 'parent-turn', status: 'completed' } })
    await host.drain()
    const settled = deliver()
    expect(settled).toMatchObject({ status: 'idle', statusStartedAt: expect.any(Number) })
    store().setState({ acknowledgedAgentsByPaneKey: { [paneKey()]: host.tick() } })

    host.translator.handle({
      type: 'prompt',
      sessionId: SESSION,
      threadId: CODEX_CHILD,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { command: 'pnpm test', availableDecisions: ['accept', 'decline'] },
      codexItemId: 'child-exec',
      promptKey: 'child-approval'
    })
    await host.drain()
    const asked = deliver()
    expect(asked).toMatchObject({ status: 'attention' })
    expect(asked.statusStartedAt).toBeGreaterThan(settled.statusStartedAt ?? Infinity)
    // The user reads the ask, then answers it.
    store().setState({ acknowledgedAgentsByPaneKey: { [paneKey()]: host.tick() } })
    const [approval] = host.prompts
    await host.answer(approval ?? '')
    host.on(CODEX_CHILD, 'turn/completed', { turn: { id: 'child-turn', status: 'completed' } })
    await host.drain()
    const answered = deliver()
    // The host rule under test elsewhere: the answer never re-dates the session's done.
    expect(answered).toMatchObject({ status: 'idle', statusStartedAt: settled.statusStartedAt })
    expect(answered.updatedAt).toBeGreaterThan(asked.updatedAt)

    const activity = renderHook(() =>
      useAgentPaneThreads({
        query: '',
        readFilter: 'all',
        groupBy: 'none',
        selectedPaneKey: null,
        showChildAgents: true
      })
    )
    const [row, ...others] = activity.result.current.allThreads
    expect(others).toHaveLength(0)
    if (!row) {
      throw new Error('activity thread missing')
    }
    expect(activityThreadStatusId(row)).toBe('done')
    expect(activityThreadRowCopy(row).needsAttention).toBe(false)
    expect(row.events.map((event) => event.state)).toEqual(['done', 'blocked', 'done'])
    expect(row.events.map((event) => event.unread)).toEqual([false, false, false])
    expect(countActivityUnread(store().getState())).toBe(0)
    host.translator.dispose()
    host.close()
  })
})
