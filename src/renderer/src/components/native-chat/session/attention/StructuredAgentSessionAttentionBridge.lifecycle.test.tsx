// @vitest-environment happy-dom

import type * as RuntimeCapabilityProofModule from '@/runtime/rpc/compatibility/runtime-capability-proof'

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentJournalTurnOutcome } from '../../../../../../shared/agent-status/lifecycle/agent-turn-outcome'
import type { AgentSessionStatusEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { NotificationDispatchRequest } from '../../../../../../shared/notification-settings-types'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { Tab } from '../../../../../../shared/tab-types'
import type { AppState } from '@/store/types'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState>) => void
}
type BridgeMocks = {
  store: TestStore | null
  emitters: ((event: AgentSessionTurnCompletionEvent) => void)[]
  statusEmitters: ((event: AgentSessionStatusEvent) => void)[]
  subscribeCompletions: Mock
  subscribeStatus: Mock
  acknowledgeAttention: Mock
  supportsCapability: Mock
  unsubscribe: Mock
}

const mocks = vi.hoisted<BridgeMocks>(() => ({
  store: null,
  emitters: [],
  statusEmitters: [],
  subscribeCompletions: vi.fn(),
  subscribeStatus: vi.fn(),
  acknowledgeAttention: vi.fn(async () => undefined),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeCapabilityProofModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionTurnCompletions: mocks.subscribeCompletions,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

vi.mock(
  '../../../../runtime/native-chat/attention/structured-agent-session-attention-acknowledgment',
  () => ({
    acknowledgeStructuredAgentSessionAttention: mocks.acknowledgeAttention
  })
)

import { StructuredAgentSessionAttentionBridge } from './StructuredAgentSessionAttentionBridge'
import {
  resetStructuredAgentSessionTurnCompletionFeedsForTests,
  structuredAgentSessionTurnCompletionFeedCountForTests as retainedCount
} from '@/runtime/native-chat/status/structured-agent-session-turn-completion-feed'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { makeTabGroup, makeUnifiedTab } from '../../../../store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '../../../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../../store/repos/repo.test-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'

// Worktree ids encode their repo (`repoId::path`); the unread reducer buckets by that prefix.
const WORKSPACE = 'repo1::/tmp/wt'
const GROUP = 'group-1'
const CHAT_TAB = 'chat-tab'
const SESSION = 'session-1'

function chatTab(overrides: Partial<Tab> = {}): Tab {
  return makeUnifiedTab({
    id: CHAT_TAB,
    worktreeId: WORKSPACE,
    groupId: GROUP,
    contentType: 'agent-session',
    entityId: SESSION,
    agentSessionAgent: 'claude',
    ...overrides
  })
}

function turnCompletion(
  sessionId = SESSION,
  outcome: AgentJournalTurnOutcome = 'success'
): AgentSessionTurnCompletion {
  return {
    scope: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'host-side-workspace',
      workspaceKind: 'git-worktree'
    },
    sessionId,
    turnId: `turn-for-${sessionId}`,
    outcome,
    completedAt: 1
  }
}

function promptFrame(
  sessionId = SESSION
): Extract<AgentSessionTurnCompletionEvent, { type: 'prompt' }> {
  return {
    type: 'prompt',
    prompt: { scope: turnCompletion().scope, sessionId, promptId: 'approval-1', raisedAt: 1 }
  }
}

const dispatched: NotificationDispatchRequest[] = []
const dismissed: { ids: string[]; paneKeys?: string[] }[] = []

function onlyDispatch(): NotificationDispatchRequest {
  expect(dispatched).toHaveLength(1)
  const request = dispatched[0]
  if (!request) {
    throw new Error('unreachable: length asserted above')
  }
  return request
}

/** The host side of a turn-completion subscription the bridge opened. */
function hostStream(index = 0): (event: AgentSessionTurnCompletionEvent) => void {
  const emit = mocks.emitters[index]
  if (!emit) {
    throw new Error(`completion stream ${index} not subscribed; opened ${mocks.emitters.length}`)
  }
  return emit
}

describe('StructuredAgentSessionAttentionBridge lifecycle integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dispatched.length = 0
    dismissed.length = 0
    // happy-dom makes globalThis the window, so this is `window.api` as the delivery tail reads it.
    vi.stubGlobal('api', {
      // Settling a working row queues a PR refresh that reads this.
      gh: {},
      notifications: {
        dispatch: (request: NotificationDispatchRequest) => {
          dispatched.push(request)
          return Promise.resolve({ delivered: true })
        },
        dismiss: (ids: string[], paneKeys?: string[]) => {
          dismissed.push({ ids, paneKeys })
          return Promise.resolve({ dismissed: 0 })
        }
      }
    })
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.emitters.length = 0
    mocks.statusEmitters.length = 0
    mocks.subscribeStatus.mockImplementation(
      (_target: unknown, emit: (event: AgentSessionStatusEvent) => void) => {
        mocks.statusEmitters.push(emit)
        return Promise.resolve({ unsubscribe: vi.fn() })
      }
    )
    mocks.subscribeCompletions.mockImplementation(
      (_target: unknown, emit: (event: AgentSessionTurnCompletionEvent) => void) => {
        mocks.emitters.push(emit)
        return Promise.resolve({ unsubscribe: mocks.unsubscribe })
      }
    )
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1' })] },
      unifiedTabsByWorktree: { [WORKSPACE]: [chatTab()] },
      groupsByWorktree: {
        [WORKSPACE]: [
          makeTabGroup({
            id: GROUP,
            worktreeId: WORKSPACE,
            activeTabId: CHAT_TAB,
            tabOrder: [CHAT_TAB]
          })
        ]
      },
      activeGroupIdByWorktree: { [WORKSPACE]: GROUP },
      activeWorktreeId: 'other-workspace',
      activeWorkspaceExecutionHostId: null,
      runtimeEnvironments: [],
      unreadTerminalTabs: {},
      unreadTerminalPanes: {},
      unreadAgentCompletionPanes: {},
      settings: { ...getDefaultSettings('/tmp'), experimentalTerminalAttention: true }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('retires the final remote tab, keeps local attention live and reopens qualified remote attention', async () => {
    vi.useFakeTimers()
    const store = mocks.store
    if (!store) {
      throw new Error('test store was not initialized')
    }
    const local = chatTab({ executionHostId: 'local' })
    const remote = chatTab({ id: 'remote-tab', executionHostId: 'runtime:env-1' })
    const teardowns: Mock[] = []
    mocks.subscribeCompletions.mockImplementation(
      (_target: RuntimeClientTarget, emit: (event: AgentSessionTurnCompletionEvent) => void) => {
        mocks.emitters.push(emit)
        const unsubscribe = vi.fn()
        teardowns.push(unsubscribe)
        return Promise.resolve({ unsubscribe })
      }
    )
    store.setState({
      unifiedTabsByWorktree: { [WORKSPACE]: [local, remote] },
      runtimeEnvironments: [
        {
          id: 'env-1',
          name: 'Paired server',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'endpoint'
        }
      ]
    })
    const view = render(<StructuredAgentSessionAttentionBridge />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(mocks.subscribeCompletions.mock.calls.map(([target]) => target)).toEqual([
      { kind: 'local' },
      { kind: 'environment', environmentId: 'env-1' }
    ])
    expect(retainedCount()).toBe(2)
    await act(async () => store.setState({ unifiedTabsByWorktree: { [WORKSPACE]: [local] } }))
    expect(teardowns[1]).toHaveBeenCalledOnce()
    expect(teardowns[0]).not.toHaveBeenCalled()
    expect(retainedCount()).toBe(1)

    const deliver = (index: number, tab: Tab, source: string, phase: string): void => {
      for (const kind of ['completion', 'prompt'] as const) {
        store.setState({
          unreadAgentCompletionPanes: {},
          unreadTerminalTabs: {},
          unreadTerminalPanes: {},
          worktreesByRepo: {
            repo1: store
              .getState()
              .worktreesByRepo.repo1.map((worktree) => ({ ...worktree, isUnread: false }))
          }
        })
        dispatched.length = 0
        const paneKey = structuredAgentSessionPaneKey(tab.id, SESSION)
        const event: AgentSessionTurnCompletionEvent =
          kind === 'completion'
            ? {
                type: kind,
                completion: { ...turnCompletion(), turnId: `turn-${phase}`, completedAt: 2 }
              }
            : {
                type: kind,
                prompt: { ...promptFrame().prompt, promptId: `prompt-${phase}`, raisedAt: 2 }
              }
        act(() => hostStream(index)(event))
        expect(store.getState().unreadAgentCompletionPanes).toEqual({
          [paneKey]: 'agent-completion'
        })
        expect(store.getState().unreadTerminalTabs).toEqual({ [tab.id]: 'agent-completion' })
        expect(store.getState().worktreesByRepo.repo1?.[0]?.isUnread).toBe(true)
        expect(onlyDispatch()).toMatchObject({
          paneKey,
          notificationSourceId: source,
          agentState: kind === 'completion' ? 'done' : 'blocked'
        })
        expect(onlyDispatch().executionHost).toBe(source === 'local' ? undefined : source)
      }
    }
    deliver(0, local, 'local', 'local-after-close')
    await act(async () =>
      store.setState({ unifiedTabsByWorktree: { [WORKSPACE]: [local, remote] } })
    )
    expect(mocks.subscribeCompletions).toHaveBeenCalledTimes(3)
    expect(mocks.subscribeCompletions.mock.calls[2]?.[0]).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
    expect(retainedCount()).toBe(2)
    deliver(2, remote, 'runtime:env-1', 'remote-after-reopen')
    expect(teardowns[0]).not.toHaveBeenCalled()
    expect(teardowns[2]).not.toHaveBeenCalled()
    view.unmount()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(teardowns).toHaveLength(3)
    teardowns.forEach((stop) => expect(stop).toHaveBeenCalledOnce())
    expect(retainedCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
