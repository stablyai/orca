// @vitest-environment happy-dom

// A host status snapshot reaches every chat's projection at once: its rows must land as one store
// publication, not one per row, or every reader of the status map runs once per row.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import type * as AgentStatusProjectionModule from '@/runtime/sync-runtime-graph/agent-status-projection'

const mocks = vi.hoisted(() => ({
  mobileStatusProjections: vi.fn(),
  removeAgentStatus: vi.fn(),
  setAgentStatus: vi.fn(),
  setGeneratedTitle: vi.fn(),
  setGeneratedTitles: vi.fn(),
  subscribeStatus: vi.fn(),
  subscribeTranscript: vi.fn(),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn(),
  writeEachRowAlone: false
}))

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  const {
    setAgentStatus,
    removeAgentStatus,
    transactAgentStatuses,
    setGeneratedTabTitleFromAgentPrompt,
    setGeneratedTabTitlesFromAgentPrompts
  } = useAppStore.getState()
  useAppStore.setState({
    setGeneratedTabTitleFromAgentPrompt: (...args) => {
      mocks.setGeneratedTitle(...args)
      setGeneratedTabTitleFromAgentPrompt(...args)
    },
    setGeneratedTabTitlesFromAgentPrompts: (updates) => {
      mocks.setGeneratedTitles(updates)
      setGeneratedTabTitlesFromAgentPrompts(updates)
    },
    setAgentStatus: (...args) => {
      mocks.setAgentStatus(...args)
      setAgentStatus(...args)
    },
    // The bridge writes rows through one transaction per tick; each applied row is one write.
    transactAgentStatuses: (operation) =>
      mocks.writeEachRowAlone
        ? operation({
            // The bridge before batching: each row written straight to the store, read live.
            getState: useAppStore.getState,
            apply: (update) => {
              const state = useAppStore.getState()
              if (update.kind === 'providerSession') {
                state.recordAgentProviderSession(
                  update.paneKey,
                  update.agent,
                  update.providerSession,
                  update.timing,
                  update.routing,
                  update.metadata
                )
              } else {
                state.setAgentStatus(
                  update.paneKey,
                  update.payload,
                  update.terminalTitle,
                  update.timing,
                  update.routing,
                  update.metadata
                )
              }
              return true
            },
            afterCommit: (effect) => effect()
          })
        : transactAgentStatuses((transaction) =>
            operation({
              ...transaction,
              apply: (update) => {
                if (update.kind !== 'providerSession') {
                  mocks.setAgentStatus(update.paneKey, update.payload)
                }
                return transaction.apply(update)
              }
            })
          ),
    removeAgentStatus: (paneKey) => {
      mocks.removeAgentStatus(paneKey)
      removeAgentStatus(paneKey)
    }
  })
  return { useAppStore }
})

vi.mock('@/runtime/sync-runtime-graph/agent-status-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusProjectionModule>()
  return {
    ...actual,
    buildRuntimeMobileAgentStatusProjection: (
      ...args: Parameters<typeof actual.buildRuntimeMobileAgentStatusProjection>
    ) => {
      mocks.mobileStatusProjections()
      return actual.buildRuntimeMobileAgentStatusProjection(...args)
    }
  }
})

// Every chat runs on the local host.
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null,
  getExecutionHostIdForWorktree: () => 'local'
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: mocks.subscribeTranscript,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { useAppStore } from '@/store'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey
} from '@/runtime/sync-runtime-graph/sync-key'
import { getDefaultSettings } from '../../../../shared/constants'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'

const structuredTab = {
  id: 'structured-tab-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex'
} satisfies Tab

const providerSession = { key: 'session_id', id: '01a002e9-9a1c-7d42-a642-e481f64446f1' } as const

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'codex',
    status: 'working',
    hostExecutionOwned: true,
    latestPrompt: 'hello',
    providerSession,
    updatedAt: 1,
    ...overrides
  }
}

function statuses(): AgentStatusEntry[] {
  return Object.values(useAppStore.getState().agentStatusByPaneKey ?? {})
}

/** The host side of the most recent status subscription. */
function feed(index = 0): { target: unknown; emit: (event: AgentSessionStatusEvent) => void } {
  const call = mocks.subscribeStatus.mock.calls[index]
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  return { target: call[0], emit: call[1] as (event: AgentSessionStatusEvent) => void }
}

// A seeded launch lists a few hundred chats; the host's first snapshot carries all of them.
const CHAT_COUNT = 247

const tabs = Array.from({ length: CHAT_COUNT }, (_, index) => ({
  ...structuredTab,
  id: `structured-tab-${index}`,
  entityId: `session-${index}`
}))

function chatSummaries(): AgentSessionStatusSummary[] {
  return tabs.map((tab, index) =>
    summary({
      sessionId: tab.entityId,
      status: index % 3 === 0 ? 'idle' : 'working',
      latestPrompt: `prompt ${index}`,
      updatedAt: index + 1
    })
  )
}

/** Every store notification, and how many changed the status map. */
function countPublications(): { all: number; status: number; stop: () => void } {
  const counts = { all: 0, status: 0, stop: () => {} }
  counts.stop = useAppStore.subscribe((state, previous) => {
    counts.all += 1
    if (state.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
      counts.status += 1
    }
  })
  return counts
}

/** The mobile session sync's store subscriber, which rebuilds the status projection per change. */
function subscribeMobileSync(): () => void {
  let previousKey = getRuntimeMobileSessionSyncKey(useAppStore.getState())
  return useAppStore.subscribe((state, previous) => {
    if (!canSkipRuntimeMobileSessionSyncKeyBuild(state, previous)) {
      previousKey = getRuntimeMobileSessionSyncKey(state, previous, previousKey)
    }
  })
}

/** Every chat in one of five states, shifted each round so each row changes state between rounds. */
function variedSummaries(round: number): AgentSessionStatusSummary[] {
  return tabs.map((tab, index) => {
    const kind = (index + round) % 5
    return summary({
      sessionId: tab.entityId,
      status: kind === 0 ? 'idle' : kind === 1 ? 'attention' : 'working',
      latestPrompt: `prompt ${index} r${round}`,
      updatedAt: 100 * round + index + 1,
      ...(kind === 0
        ? { turnOutcome: 'interruption' as const, lastAssistantMessage: `said ${index}` }
        : {}),
      ...(kind === 2 ? { toolName: 'Bash', toolInput: `ls ${index}`, model: 'gpt-x' } : {}),
      ...(kind === 3
        ? {
            backgroundTasks: [
              {
                id: `child-${index}`,
                kind: 'agent' as const,
                name: 'deep_review',
                description: 'Review',
                state: 'working' as const,
                startedAt: 500
              }
            ]
          }
        : {}),
      ...(kind === 4 && round > 0 ? { hostExecutionOwned: undefined } : {})
    })
  })
}

/** Three snapshots, then single updates; the status map after each step, and the tab labels. */
async function snapshotRounds(): Promise<{ rows: unknown[]; labels: unknown[] }> {
  await renderBridge()
  const rows: unknown[] = []
  for (const round of [0, 1, 2]) {
    vi.mocked(Date.now).mockReturnValue(1_000 + round)
    await act(async () => feed().emit({ type: 'snapshot', sessions: variedSummaries(round) }))
    rows.push(structuredClone(useAppStore.getState().agentStatusByPaneKey))
  }
  for (const index of [3, 7, 11]) {
    const session = variedSummaries(2)[index]!
    await act(async () =>
      feed().emit({
        type: 'status',
        session: {
          ...session,
          status: 'idle',
          turnOutcome: 'interruption',
          updatedAt: 50_000 + index
        }
      })
    )
  }
  rows.push(structuredClone(useAppStore.getState().agentStatusByPaneKey))
  const labels = (useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []).map((tab) => [
    tab.id,
    tab.label,
    tab.generatedLabel ?? null
  ])
  cleanup()
  return { rows, labels }
}

async function renderBridge(): Promise<void> {
  render(<StructuredAgentSessionStatusBridge />)
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
}

describe('a status snapshot of many chats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    // The status evidence clock, so rows written on different ticks compare equal.
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    useAppStore.setState({
      agentStatusByPaneKey: {},
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      unifiedTabsByWorktree: { 'wt-1': tabs }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.restoreAllMocks()
  })

  it("applies a snapshot of every listed chat's status as one publication", async () => {
    await renderBridge()
    const stopMobileSync = subscribeMobileSync()
    mocks.mobileStatusProjections.mockClear()
    // Every publication re-runs every store reader, so a publication per row is the burst.
    const publications = countPublications()

    await act(async () => feed().emit({ type: 'snapshot', sessions: chatSummaries() }))
    publications.stop()
    stopMobileSync()

    expect(statuses()).toHaveLength(CHAT_COUNT)
    expect(publications.status).toBe(1)
    expect(publications.all).toBe(1)
    expect(mocks.mobileStatusProjections).toHaveBeenCalledOnce()
    // The rows' generated-title requests go out as one batch, not a call per row.
    expect(mocks.setGeneratedTitle).not.toHaveBeenCalled()
    expect(mocks.setGeneratedTitles).toHaveBeenCalledOnce()
    expect(mocks.setGeneratedTitles.mock.calls[0][0]).toHaveLength(CHAT_COUNT)
  })

  it('writes the same rows and titles as writing each row on its own', async () => {
    const tabsBefore = structuredClone(useAppStore.getState().unifiedTabsByWorktree)
    const batched = await snapshotRounds()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockClear()
    useAppStore.setState({ agentStatusByPaneKey: {}, unifiedTabsByWorktree: tabsBefore })
    mocks.writeEachRowAlone = true
    const perRow = await snapshotRounds()
    mocks.writeEachRowAlone = false

    expect(Object.keys(batched.rows[0] ?? {})).toHaveLength(CHAT_COUNT)
    expect(batched).toEqual(perRow)
  })

  it('still removes a row, and applies a later single update on the next tick', async () => {
    await renderBridge()
    await act(async () => feed().emit({ type: 'snapshot', sessions: chatSummaries() }))
    const [first, second] = chatSummaries()
    const paneKey = (tab: (typeof tabs)[number]): string =>
      structuredAgentSessionPaneKey(tab.id, tab.entityId)
    expect(useAppStore.getState().agentStatusByPaneKey[paneKey(tabs[0])]).toBeDefined()

    await act(async () => feed().emit({ type: 'status', session: { ...first, status: null } }))
    expect(mocks.removeAgentStatus).toHaveBeenCalledWith(paneKey(tabs[0]))
    expect(useAppStore.getState().agentStatusByPaneKey[paneKey(tabs[0])]).toBeUndefined()

    const publications = countPublications()
    await act(async () =>
      feed().emit({ type: 'status', session: { ...second, status: 'idle', updatedAt: 9_999 } })
    )
    publications.stop()
    expect(publications.status).toBe(1)
    expect(useAppStore.getState().agentStatusByPaneKey[paneKey(tabs[1])]).toMatchObject({
      state: 'done',
      updatedAt: 9_999
    })
    expect(statuses()).toHaveLength(CHAT_COUNT - 1)
  })
})
