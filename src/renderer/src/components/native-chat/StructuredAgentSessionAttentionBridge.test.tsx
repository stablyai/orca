// @vitest-environment happy-dom

// Exercise the real attention path from completion stream to indicators/OS delivery; mock only transport and preload.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentJournalTurnOutcome } from '../../../../shared/agent-status/lifecycle/agent-turn-outcome'
import { modelRefusalReadStates } from './structured-model-refusal.test-fixture'
import { structuredAttentionReadObservation } from './structured-attention-read-observation'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session/agent-session-wire'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { NotificationDispatchRequest } from '../../../../shared/notification-settings-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

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
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionTurnCompletions: mocks.subscribeCompletions,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus,
  acknowledgeStructuredAgentSessionAttention: mocks.acknowledgeAttention
}))

import { StructuredAgentSessionAttentionBridge } from './StructuredAgentSessionAttentionBridge'
import {
  emitAgentSubjectReads,
  type AgentSubjectRead,
  type StructuredSubjectRead
} from '@/attention/agent-subject-read-actions'

import { resetStructuredAgentSessionTurnCompletionFeedsForTests } from '@/runtime/structured-agent-session-turn-completion-feed'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { makeTabGroup, makeUnifiedTab } from '../../store/slices/store-session-test-harness'
import { makeWorktree, TEST_REPO } from '../../store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'

// Worktree ids encode their repo (`repoId::path`); the unread reducer buckets by that prefix.
const WORKSPACE = 'repo1::/tmp/wt'
const GROUP = 'group-1'
const CHAT_TAB = 'chat-tab'
const SESSION = 'session-1'
const CHAT_SUBJECT = structuredAgentSessionPaneKey(CHAT_TAB, SESSION)

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

function completionFrame(
  sessionId = SESSION,
  outcome: AgentJournalTurnOutcome = 'success'
): AgentSessionTurnCompletionEvent {
  return { type: 'completion', completion: turnCompletion(sessionId, outcome) }
}

/** A host that predates the outcome field, which the current wire type makes required. */

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

function indicators(): Record<string, unknown> {
  const state = mocks.store?.getState()
  return {
    workspaceBold: state?.worktreesByRepo.repo1?.[0]?.isUnread === true,
    paneDot: state?.unreadAgentCompletionPanes[CHAT_SUBJECT],
    tabDot: state?.unreadTerminalTabs[CHAT_TAB]
  }
}

describe('StructuredAgentSessionAttentionBridge', () => {
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

  it('keeps first-read semantics and retires a viewed model refusal on its owning target', async () => {
    render(<StructuredAgentSessionAttentionBridge />)
    await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())
    const { before, after } = modelRefusalReadStates()
    const read: StructuredSubjectRead = {
      sessionId: SESSION,
      target: { kind: 'local' },
      observedCursor: before.cursor,
      observationKey: structuredAttentionReadObservation(before)
    }
    const valid: AgentSubjectRead = { subjectKey: CHAT_SUBJECT, structured: read }
    const emit = (first: AgentSubjectRead): void => {
      act(() => emitAgentSubjectReads([CHAT_SUBJECT], [first, valid], 'explicit'))
    }
    emit({ subjectKey: CHAT_SUBJECT })
    emit({ subjectKey: CHAT_SUBJECT, structured: { ...read, sessionId: 'other-session' } })
    emit({
      subjectKey: CHAT_SUBJECT,
      structured: { ...read, target: { kind: 'environment', environmentId: 'other-host' } }
    })
    expect(mocks.acknowledgeAttention).not.toHaveBeenCalled()
    expect(dismissed).toEqual([])
    const later: AgentSubjectRead = {
      ...valid,
      structured: {
        ...read,
        observedCursor: after.cursor,
        observationKey: structuredAttentionReadObservation(after)
      }
    }
    act(() => emitAgentSubjectReads([CHAT_SUBJECT], [valid, later], 'explicit'))
    expect(mocks.acknowledgeAttention).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      SESSION,
      before.cursor
    )
    dismissed.length = 0
    act(() => hostStream()(completionFrame(SESSION, 'failure')))
    expect(onlyDispatch()).toMatchObject({ agentTurnOutcome: 'failure' })
    expect(later.structured?.observationKey).not.toBe(read.observationKey)
    act(() => emitAgentSubjectReads([CHAT_SUBJECT], [later]))
    await waitFor(() => expect(mocks.acknowledgeAttention).toHaveBeenCalledTimes(2))
    expect(mocks.acknowledgeAttention).toHaveBeenLastCalledWith(
      { kind: 'local' },
      SESSION,
      after.cursor
    )
    expect(dismissed.flatMap(({ paneKeys }) => paneKeys ?? [])).toContain(CHAT_SUBJECT)
  })

  // Separate status/completion sockets are unordered; derive wording from completion despite conflicting mirrors.

  // Ambiguous workspace ids cannot locate an unstamped tab until its snapshot records the host.
  it('pauses an unrecorded chat while its workspace id names two hosts, until its host is recorded', async () => {
    render(<StructuredAgentSessionAttentionBridge />)
    await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())
    expect(mocks.subscribeCompletions.mock.calls[0]?.[0]).toEqual({ kind: 'local' })
    await act(async () =>
      mocks.store?.setState({
        worktreesByRepo: {
          repo1: [
            makeWorktree({ id: WORKSPACE, repoId: 'repo1', hostId: 'local' }),
            makeWorktree({ id: WORKSPACE, repoId: 'repo1', hostId: 'ssh:qa' })
          ]
        }
      })
    )
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()

    await act(async () =>
      mocks.store?.setState({
        unifiedTabsByWorktree: { [WORKSPACE]: [chatTab({ executionHostId: 'local' })] }
      })
    )
    await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledTimes(2))
    expect(mocks.subscribeCompletions.mock.calls[1]?.[0]).toEqual({ kind: 'local' })
    act(() => hostStream(1)(completionFrame()))
    expect(onlyDispatch().notificationSourceId).toBe('local')
    expect(indicators().paneDot).toBe('agent-completion')
  })
})
