// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import * as statusOwner from '@/runtime/structured-agent-session-owner'
import * as statusProjection from './structured-agent-session-status-projection'
import { tabActivationPatch } from '@/store/slices/tabs/tabs-focus-actions'
import { makeWorktree } from '@/store/slices/store-test-helpers'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState>) => void
}

const mocks = vi.hoisted(() => {
  const hoisted: {
    store: TestStore | null
    subscribeStatus: ReturnType<typeof vi.fn>
    supportsCapability: ReturnType<typeof vi.fn>
    unsubscribe: ReturnType<typeof vi.fn>
    applyStatus: ReturnType<typeof vi.fn<(update: unknown) => void>>
  } = {
    store: null,
    subscribeStatus: vi.fn(),
    supportsCapability: vi.fn(),
    unsubscribe: vi.fn(),
    applyStatus: vi.fn()
  }
  return hoisted
})

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  const { transactAgentStatuses } = useAppStore.getState()
  useAppStore.setState({
    transactAgentStatuses: (operation) =>
      transactAgentStatuses((transaction) =>
        operation({
          ...transaction,
          apply: (update) => {
            mocks.applyStatus(update)
            return transaction.apply(update)
          }
        })
      )
  })
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { useAppStore } from '@/store'
import { notifyStructuredLaunchListeners } from '@/lib/structured-agent-session-launch-registry'
import {
  writeStructuredAgentLaunchRecord,
  deleteStructuredAgentLaunchRecord
} from '@/lib/structured-agent-session-launch-persistence'
import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'

const floatingTab = {
  id: 'floating-chat-1',
  worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
  groupId: 'floating-group',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex',
  executionHostId: LOCAL_EXECUTION_HOST_ID
} satisfies Tab

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
    agent: 'codex',
    status: 'idle',
    latestPrompt: 'hello',
    updatedAt: 1,
    ...overrides
  }
}

function emit(event: AgentSessionStatusEvent): void {
  const call = mocks.subscribeStatus.mock.calls.at(-1)
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  const send: (event: AgentSessionStatusEvent) => void = call[1]
  act(() => send(event))
}

function pins(): AppState['structuredSessionLaunchDirectoryByTabId'] {
  return mocks.store?.getState().structuredSessionLaunchDirectoryByTabId ?? {}
}

function statuses() {
  return Object.values(useAppStore.getState().agentStatusByPaneKey)
}
function feed(index = 0): { target: unknown; emit: (event: AgentSessionStatusEvent) => void } {
  const call = mocks.subscribeStatus.mock.calls[index]
  return { target: call[0], emit: call[1] }
}

// Observe actual collection work without replacing the private members or groups.
function measureMembership(trigger: () => void) {
  const work = { members: 0, groups: 0 }
  function observe<T>(iterator: MapIterator<T>): MapIterator<T> {
    const next = iterator.next.bind(iterator)
    iterator.next = () => {
      const item = next()
      const value: unknown = Array.isArray(item.value) ? item.value[1] : item.value
      if (!item.done && value && typeof value === 'object') {
        if ('paneKey' in value && 'group' in value && 'tab' in value) {
          work.members += 1
        }
        if ('feed' in value && 'unsubscribe' in value) {
          work.groups += 1
        }
      }
      return item
    }
    return iterator
  }
  const values = Map.prototype.values
  const entries = Map.prototype[Symbol.iterator]
  const spies = [
    vi.spyOn(Map.prototype, 'values').mockImplementation(function (this: Map<unknown, unknown>) {
      return observe(values.call(this))
    }),
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return observe(entries.call(this))
    })
  ]
  try {
    act(trigger)
    return work
  } finally {
    for (const spy of spies) {
      spy.mockRestore()
    }
  }
}

describe('StructuredAgentSessionStatusBridge pinned launch directory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      structuredSessionLaunchDirectoryByTabId: {},
      structuredChatSleptAtByPaneKey: {},
      agentStatusByPaneKey: {},
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it.each([
    [10, 2],
    [100, 2],
    [10, 10],
    [100, 100]
  ])(
    'bounds real status triggers and first-snapshot companion writes for %i sessions on %i hosts',
    async (count, hostCount) => {
      const perHost = count / hostCount
      const feeds = Array.from({ length: hostCount }, (_, i) =>
        getStructuredAgentSessionStatusFeed(
          i === 0
            ? { kind: 'local' }
            : {
                kind: 'environment',
                environmentId: hostCount === 2 ? 'paired' : `paired-${i}`
              }
        )
      )
      const leases = feeds.map((owner) => vi.spyOn(owner, 'activate'))
      const listeners = feeds.map((owner) => vi.spyOn(owner, 'subscribe'))
      const reads = feeds.map((owner) => vi.spyOn(owner, 'getSessionObservation'))
      const snapshots = feeds.map((owner) => vi.spyOn(owner, 'getSnapshot'))
      let idReads = 0
      const owners = vi.spyOn(statusOwner, 'structuredAgentSessionOwnerForTab')
      const projects = vi.spyOn(statusProjection, 'projectStatus')
      const tabs = Array.from(
        { length: count },
        (_, i) =>
          ({
            ...floatingTab,
            get id() {
              idReads += 1
              return `chat-${i}`
            },
            entityId: `session-${i}`,
            executionHostId:
              i % hostCount
                ? `runtime:${hostCount === 2 ? 'paired' : `paired-${i % hostCount}`}`
                : 'local'
          }) satisfies Tab
      )
      useAppStore.setState({ unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs } })
      let commits = 0
      let publications = 0
      let sleepWrites = 0
      let directoryWrites = 0
      const stop = useAppStore.subscribe((state, previous) => {
        publications += 1
        sleepWrites += Number(
          state.structuredChatSleptAtByPaneKey !== previous.structuredChatSleptAtByPaneKey
        )
        directoryWrites += Number(
          state.structuredSessionLaunchDirectoryByTabId !==
            previous.structuredSessionLaunchDirectoryByTabId
        )
        if (state.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
          commits += 1
        }
      })
      const view = render(<StructuredAgentSessionStatusBridge />)
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(hostCount))
      const rows = tabs.map((tab, i) =>
        summary({ sessionId: tab.entityId, updatedAt: 100 + i, launchDirectory: '/project' })
      )
      const resetWork = () => {
        commits = publications = sleepWrites = directoryWrites = idReads = 0
        mocks.applyStatus.mockClear()
        owners.mockClear()
        projects.mockClear()
        for (const read of [...reads, ...snapshots]) {
          read.mockClear()
        }
      }
      const linearWork = () => {
        expect(owners.mock.calls.length).toBeLessThanOrEqual(5 * count)
        expect(idReads).toBeLessThanOrEqual(8 * count)
      }
      for (let i = 0; i < hostCount; i += 1) {
        resetWork()
        const work = measureMembership(() => feed(i).emit({ type: 'snapshot', sessions: rows }))
        expect(work).toEqual({ members: 0, groups: hostCount })
        expect(reads.reduce((sum, read) => sum + read.mock.calls.length, 0)).toBe(perHost)
        expect(snapshots.reduce((sum, read) => sum + read.mock.calls.length, 0)).toBe(
          perHost * (i === 0 ? 2 : 1)
        )
        expect(commits).toBe(1)
        expect(projects).toHaveBeenCalledTimes(perHost)
        expect(mocks.applyStatus).toHaveBeenCalledTimes(perHost)
        expect([sleepWrites, directoryWrites, publications]).toEqual([
          perHost,
          i === 0 ? perHost : 0,
          1 + perHost * (i === 0 ? 2 : 1)
        ])
        linearWork()
      }
      for (const spy of [...leases, ...listeners]) {
        expect(spy).toHaveBeenCalledOnce()
      }
      expect(statuses()).toHaveLength(count)
      const before = useAppStore.getState().agentStatusByPaneKey
      resetWork()
      act(() => {
        feed(0).emit({ type: 'snapshot', sessions: rows })
        feed(1).emit({ type: 'snapshot', sessions: rows })
      })
      expect(commits).toBe(0)
      expect(projects).not.toHaveBeenCalled()
      expect(mocks.applyStatus).not.toHaveBeenCalled()
      expect(useAppStore.getState().agentStatusByPaneKey).toBe(before)
      linearWork()
      resetWork()
      const statusWork = measureMembership(() =>
        feed(0).emit({ type: 'status', session: { ...rows[0], status: 'working', updatedAt: 500 } })
      )
      expect(statusWork).toEqual({ members: 0, groups: hostCount })
      expect(reads.reduce((sum, read) => sum + read.mock.calls.length, 0)).toBe(perHost)
      expect(snapshots.reduce((sum, read) => sum + read.mock.calls.length, 0)).toBe(2 * perHost)
      expect(commits).toBe(1)
      expect(projects).toHaveBeenCalledOnce()
      expect(mocks.applyStatus).toHaveBeenCalledOnce()
      linearWork()
      resetWork()
      const activationWork = measureMembership(() =>
        useAppStore.setState(
          tabActivationPatch(
            useAppStore.getState(),
            tabs[1],
            FLOATING_TERMINAL_WORKTREE_ID,
            undefined,
            false
          )
        )
      )
      expect(activationWork.members).toBeLessThanOrEqual(4 * count)
      expect(activationWork.groups).toBeLessThanOrEqual(5 * hostCount)
      expect(commits).toBe(0)
      expect(projects).toHaveBeenCalledOnce()
      expect(mocks.applyStatus).not.toHaveBeenCalled()
      linearWork()
      resetWork()
      act(() => notifyStructuredLaunchListeners())
      expect(projects).not.toHaveBeenCalled()
      expect(commits).toBe(0)
      expect(mocks.applyStatus).not.toHaveBeenCalled()
      linearWork()
      const remaining = useAppStore
        .getState()
        .unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID].filter(
          (tab) => tab.executionHostId !== 'local'
        )
      resetWork()
      const removalWork = measureMembership(() =>
        useAppStore.setState({
          unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: remaining }
        })
      )
      expect(removalWork.members).toBeLessThanOrEqual(4 * count)
      expect(removalWork.groups).toBeLessThanOrEqual(5 * hostCount)
      expect(mocks.unsubscribe).toHaveBeenCalledOnce()
      expect(commits).toBe(1)
      expect(statuses()).toHaveLength(count - perHost)
      expect(projects).not.toHaveBeenCalled()
      expect(mocks.applyStatus).not.toHaveBeenCalled()
      linearWork()
      owners.mockRestore()
      projects.mockRestore()
      stop()
      view.unmount()
      for (const spy of [...leases, ...listeners, ...reads, ...snapshots]) {
        spy.mockRestore()
      }
    }
  )

  it('keeps shared leases and a later host reintroduced synchronously by feed release', async () => {
    const local = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    const remote = getStructuredAgentSessionStatusFeed({
      kind: 'environment',
      environmentId: 'paired'
    })
    const released = [vi.fn(), vi.fn()]
    mocks.subscribeStatus
      .mockResolvedValueOnce({ unsubscribe: released[0] })
      .mockResolvedValueOnce({ unsubscribe: released[1] })
    const remoteLease = vi.spyOn(remote, 'activate')
    const tabs: Tab[] = [
      floatingTab,
      { ...floatingTab, id: 'second', entityId: 'session-2' },
      { ...floatingTab, id: 'remote', entityId: 'session-3', executionHostId: 'runtime:paired' }
    ]
    useAppStore.setState({ unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs } })
    const view = render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
    act(() => {
      feed(0).emit({
        type: 'snapshot',
        sessions: tabs.slice(0, 2).map((tab) =>
          summary({
            sessionId: tab.entityId,
            hostExecutionOwned: true,
            sleptAt: 5,
            launchDirectory: '/project'
          })
        )
      })
      feed(1).emit({
        type: 'snapshot',
        sessions: [summary({ sessionId: 'session-3', sleptAt: 7 })]
      })
    })
    act(() =>
      useAppStore.setState({
        unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs.slice(1) }
      })
    )
    expect(released.every((release) => release.mock.calls.length === 0)).toBe(true)
    expect(statuses()).toHaveLength(2)
    expect(pins().second?.sessionId).toBe('session-2')
    expect(pins()[floatingTab.id]).toBeUndefined()
    let reenter = true
    const stop = local.subscribe(() => {
      if (!reenter) {
        return
      }
      reenter = false
      useAppStore.setState({
        unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [tabs[2]] }
      })
    })
    try {
      act(() =>
        useAppStore.setState({ unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [] } })
      )
      expect(reenter).toBe(false)
      expect(released[0]).toHaveBeenCalledOnce()
      expect(released[1]).not.toHaveBeenCalled()
      expect(remoteLease).toHaveBeenCalledOnce()
      act(() =>
        feed(1).emit({
          type: 'status',
          session: summary({ sessionId: 'session-3', status: 'working', updatedAt: 900 })
        })
      )
      expect(statuses()).toEqual([expect.objectContaining({ updatedAt: 900, state: 'working' })])
      expect(pins()).toEqual({})
      expect(Object.values(useAppStore.getState().structuredChatSleptAtByPaneKey)).toEqual([null])
      view.unmount()
      expect(released[1]).toHaveBeenCalledOnce()
    } finally {
      stop()
      remoteLease.mockRestore()
    }
  })

  it.each(['publication', 'release'] as const)(
    'rederives removed companions and host activation after a one-shot %s failure',
    async (failure) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let stop = () => {}
      try {
        render(<StructuredAgentSessionStatusBridge />)
        await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
        emit({ type: 'snapshot', sessions: [summary({ sleptAt: 5, launchDirectory: '/project' })] })
        const paneKey = statuses()[0].paneKey
        let threw = false
        if (failure === 'publication') {
          stop = useAppStore.subscribe((state) => {
            if (!threw && !state.agentStatusByPaneKey[paneKey]) {
              threw = true
              throw new Error('removal subscriber failed once')
            }
          })
        } else {
          mocks.unsubscribe.mockImplementationOnce(() => {
            threw = true
            throw new Error('transport release failed once')
          })
        }
        act(() =>
          useAppStore.setState({
            unifiedTabsByWorktree: {
              [FLOATING_TERMINAL_WORKTREE_ID]: [
                { ...floatingTab, entityId: 'replacement', executionHostId: 'runtime:paired' }
              ]
            }
          })
        )
        expect(threw).toBe(true)
        expect(warning).toHaveBeenCalled()
        // A subscriber throws after installation; a release throw happens before projection.
        expect(Boolean(useAppStore.getState().agentStatusByPaneKey[paneKey])).toBe(
          failure === 'release'
        )
        expect(pins()[floatingTab.id]?.sessionId).toBe(floatingTab.entityId)
        act(() => notifyStructuredLaunchListeners())
        expect(useAppStore.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
        expect(useAppStore.getState().structuredChatSleptAtByPaneKey[paneKey]).toBeUndefined()
        expect(pins()).toEqual({})
        await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
        act(() =>
          feed(1).emit({
            type: 'snapshot',
            sessions: [summary({ sessionId: 'replacement', updatedAt: 50 })]
          })
        )
        expect(statuses()).toEqual([expect.objectContaining({ updatedAt: 50 })])
      } finally {
        stop()
        warning.mockRestore()
      }
    }
  )

  it('rekeys an older unstamped tab when its worktree owner arrives', async () => {
    const legacyTab = { ...floatingTab, worktreeId: 'wt-1', executionHostId: undefined }
    useAppStore.setState({ unifiedTabsByWorktree: { 'wt-1': [legacyTab] } })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    expect(feed().target).toEqual({ kind: 'local' })
    act(() => feed().emit({ type: 'snapshot', sessions: [summary({ workspaceId: 'wt-1' })] }))
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            makeWorktree({
              id: 'wt-1',
              repoId: 'repo',
              hostId: 'runtime:env-1',
              runtimeOwnerEnvironmentId: 'env-1'
            })
          ]
        }
      })
    )
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
    expect(feed(1).target).toEqual({ kind: 'environment', environmentId: 'env-1' })
    act(() =>
      feed(1).emit({
        type: 'snapshot',
        sessions: [summary({ workspaceId: 'wt-1', updatedAt: 20 })]
      })
    )
    expect(statuses()[0].updatedAt).toBe(20)
    act(() =>
      feed().emit({ type: 'status', session: summary({ workspaceId: 'wt-1', updatedAt: 30 }) })
    )
    expect(statuses()[0].updatedAt).toBe(20)
  })

  it('reads earlier projections in an outer transaction for same-pane clock continuity', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() =>
      useAppStore.getState().transactAgentStatuses(() => {
        feed().emit({ type: 'status', session: summary({ status: 'working', updatedAt: 100 }) })
        feed().emit({ type: 'status', session: summary({ status: 'working', updatedAt: 200 }) })
      })
    )
    expect(statuses()[0]).toMatchObject({
      updatedAt: 200,
      stateStartedAt: 100,
      mainAgent: { stateStartedAt: 100 }
    })
  })

  it('isolates an installed revocation failure and still reconnects and projects', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let stop = () => {}
    let later = () => {}
    try {
      render(<StructuredAgentSessionStatusBridge />)
      await act(() => Promise.resolve())
      act(() =>
        feed().emit({
          type: 'status',
          session: summary({ status: 'working', hostExecutionOwned: true })
        })
      )
      const projection = vi.spyOn(statusProjection, 'projectStatus')
      const afterBridge = vi.fn()
      later = getStructuredAgentSessionStatusFeed({ kind: 'local' }).subscribe(afterBridge)
      let threw = false
      stop = useAppStore.subscribe((state) => {
        if (!threw && !Object.values(state.agentStatusByPaneKey)[0]?.structuredHostOwned) {
          threw = true
          throw new Error('revocation subscriber failed')
        }
      })
      act(() => expect(() => feed().emit({ type: 'end' })).not.toThrow())
      expect(statuses()[0].structuredHostOwned).toBeUndefined()
      expect(warning).toHaveBeenCalled()
      expect(afterBridge).toHaveBeenCalledTimes(2)
      // The second disconnect emission retries the unconsumed input even though the row installed.
      expect(projection).toHaveBeenCalledTimes(2)
      await act(() => vi.advanceTimersByTimeAsync(300))
      expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2)
      act(() =>
        feed(1).emit({
          type: 'snapshot',
          sessions: [summary({ status: 'working', hostExecutionOwned: true, updatedAt: 20 })]
        })
      )
      expect(statuses()[0]).toMatchObject({ structuredHostOwned: true, updatedAt: 20 })
      projection.mockRestore()
    } finally {
      stop()
      later()
      warning.mockRestore()
      vi.useRealTimers()
    }
  })

  it('projects a launch failure without a feed row and clears it on retry', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    for (const failedAt of [42, undefined]) {
      act(() => {
        writeStructuredAgentLaunchRecord({
          sessionId: floatingTab.entityId,
          agent: 'codex',
          executionHostId: 'local',
          lifecycle: 'failed',
          clientOperationId: 'failure-test',
          payloadFingerprint: 'failure-test',
          expectedRuntimeFence: null,
          failedAt
        })
        notifyStructuredLaunchListeners()
      })
      expect(statuses()[0]).toMatchObject({
        state: 'done',
        updatedAt: failedAt ?? floatingTab.createdAt,
        mainAgent: { outcome: 'failure' }
      })
      act(() => {
        deleteStructuredAgentLaunchRecord(floatingTab.entityId)
        notifyStructuredLaunchListeners()
      })
      expect(statuses()).toHaveLength(0)
    }
  })

  it.each([100, undefined])(
    'preserves warm host-move markers and clock with authoritative start %s',
    async (statusStartedAt) => {
      render(<StructuredAgentSessionStatusBridge />)
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
      act(() =>
        feed().emit({
          type: 'status',
          session: summary({ status: 'working', updatedAt: 100, statusStartedAt })
        })
      )
      const paneKey = statuses()[0].paneKey
      const acknowledged = { [paneKey]: 999 }
      const manual = { [paneKey]: 100 }
      const cleared = { [paneKey]: 90 }
      useAppStore.getState().registerAgentLaunchConfig(paneKey, { agentArgs: '', agentEnv: {} })
      const configs = useAppStore.getState().agentLaunchConfigByPaneKey
      useAppStore.setState({
        acknowledgedAgentsByPaneKey: acknowledged,
        manuallyUnreadTurnsByPaneKey: manual,
        activityClearedAtByPaneKey: cleared
      })
      const remote = getStructuredAgentSessionStatusFeed({
        kind: 'environment',
        environmentId: 'paired'
      })
      const release = remote.activate()
      try {
        await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
        act(() =>
          feed(1).emit({
            type: 'snapshot',
            sessions: [summary({ status: 'working', updatedAt: 200, statusStartedAt })]
          })
        )
        act(() =>
          useAppStore.setState({
            unifiedTabsByWorktree: {
              [FLOATING_TERMINAL_WORKTREE_ID]: [
                { ...floatingTab, executionHostId: 'runtime:paired' }
              ]
            }
          })
        )
        const assertContinuity = () => {
          expect(statuses()[0]).toMatchObject({
            updatedAt: 200,
            stateStartedAt: 100,
            mainAgent: { stateStartedAt: 100 }
          })
          expect(useAppStore.getState().acknowledgedAgentsByPaneKey).toBe(acknowledged)
          expect(useAppStore.getState().manuallyUnreadTurnsByPaneKey).toBe(manual)
          expect(useAppStore.getState().activityClearedAtByPaneKey).toBe(cleared)
          expect(useAppStore.getState().agentLaunchConfigByPaneKey).toBe(configs)
        }
        assertContinuity()
        act(() =>
          feed().emit({ type: 'status', session: summary({ status: 'attention', updatedAt: 300 }) })
        )
        assertContinuity()
        act(() =>
          feed(1).emit({
            type: 'status',
            session: summary({ status: 'working', updatedAt: 200, statusStartedAt })
          })
        )
        assertContinuity()
        act(() =>
          useAppStore.setState({
            unifiedTabsByWorktree: {
              [FLOATING_TERMINAL_WORKTREE_ID]: [{ ...floatingTab, executionHostId: 'runtime:cold' }]
            }
          })
        )
        expect(statuses()).toHaveLength(0)
        expect(useAppStore.getState().acknowledgedAgentsByPaneKey[paneKey]).toBeUndefined()
        await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(3))
        act(() =>
          feed(2).emit({
            type: 'snapshot',
            sessions: [summary({ status: 'working', updatedAt: 400, statusStartedAt })]
          })
        )
        expect(statuses()[0].stateStartedAt).toBe(statusStartedAt ?? 400)
        act(() =>
          useAppStore.setState({
            unifiedTabsByWorktree: {
              [FLOATING_TERMINAL_WORKTREE_ID]: [
                { ...floatingTab, entityId: 'replacement', executionHostId: 'runtime:cold' }
              ]
            }
          })
        )
        expect(statuses()).toHaveLength(0)
      } finally {
        release()
      }
    }
  )

  it('keeps the host-published pinned folder for the tab and drops it when the tab goes', async () => {
    const view = render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    emit({ type: 'snapshot', sessions: [summary({ launchDirectory: '/home/me/original' })] })

    expect(pins()).toEqual({
      [floatingTab.id]: { sessionId: 'session-1', launchDirectory: '/home/me/original' }
    })

    act(() => mocks.store?.setState({ unifiedTabsByWorktree: {} }))
    view.rerender(<StructuredAgentSessionStatusBridge />)
    expect(pins()).toEqual({})
  })

  it.each([
    { label: 'Renamed' },
    { agentSessionAgent: 'claude' as const },
    { worktreeId: 'another-workspace' }
  ])('keeps sleep and directory untouched for metadata %j', async (metadata) => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    emit({ type: 'snapshot', sessions: [summary({ sleptAt: 5, launchDirectory: '/project' })] })
    const state = useAppStore.getState()
    const slept = state.structuredChatSleptAtByPaneKey
    const directory = state.structuredSessionLaunchDirectoryByTabId
    const originalActions = {
      setStructuredChatSleptAt: state.setStructuredChatSleptAt,
      setStructuredSessionLaunchDirectory: state.setStructuredSessionLaunchDirectory,
      clearStructuredSessionLaunchDirectory: state.clearStructuredSessionLaunchDirectory
    }
    const sleepSetter = vi.spyOn(state, 'setStructuredChatSleptAt')
    const directorySetter = vi.spyOn(state, 'setStructuredSessionLaunchDirectory')
    const directoryClear = vi.spyOn(state, 'clearStructuredSessionLaunchDirectory')
    let publications = 0
    const stop = useAppStore.subscribe((next, previous) => {
      if (
        next.structuredChatSleptAtByPaneKey !== previous.structuredChatSleptAtByPaneKey ||
        next.structuredSessionLaunchDirectoryByTabId !==
          previous.structuredSessionLaunchDirectoryByTabId
      ) {
        publications += 1
      }
    })
    act(() =>
      useAppStore.setState({
        unifiedTabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [{ ...floatingTab, ...metadata }]
        }
      })
    )
    expect(Object.values(useAppStore.getState().agentStatusByPaneKey)[0]).toMatchObject({
      terminalTitle: metadata.label ?? floatingTab.label,
      agentType: metadata.agentSessionAgent ?? floatingTab.agentSessionAgent,
      worktreeId: metadata.worktreeId ?? floatingTab.worktreeId
    })
    expect(useAppStore.getState().structuredChatSleptAtByPaneKey).toBe(slept)
    expect(useAppStore.getState().structuredSessionLaunchDirectoryByTabId).toBe(directory)
    expect(publications).toBe(0)
    expect(sleepSetter).not.toHaveBeenCalled()
    expect(directorySetter).not.toHaveBeenCalled()
    expect(directoryClear).not.toHaveBeenCalled()
    stop()
    sleepSetter.mockRestore()
    directorySetter.mockRestore()
    directoryClear.mockRestore()
    useAppStore.setState(originalActions)
  })

  it('records nothing when an older host omits the field', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    emit({ type: 'snapshot', sessions: [summary()] })

    expect(pins()).toEqual({})
  })

  it('never records a path published by a remote runtime', async () => {
    // The tab records the paired host that owns the chat.
    mocks.store?.setState({
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          { ...floatingTab, executionHostId: toRuntimeExecutionHostId('env-1') }
        ]
      }
    })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    emit({ type: 'snapshot', sessions: [summary({ launchDirectory: '/srv/remote/floating' })] })

    // The summary itself landed; only its path was withheld.
    expect(Object.keys(mocks.store?.getState().agentStatusByPaneKey ?? {})).toHaveLength(1)
    expect(pins()).toEqual({})
  })
})
