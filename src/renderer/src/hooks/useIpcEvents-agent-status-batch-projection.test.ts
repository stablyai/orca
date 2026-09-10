import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '../store/slices/store-test-helpers'
import type { AgentStatusBatchUpdate, AgentStatusUpdate } from '../store/slices/agent-status'
import type { AppState } from '../store/types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  buildStoreState,
  FUTURE_LEAF_ID,
  FUTURE_PANE_KEY,
  type AgentStatusSetData,
  type StoreLike
} from './ipc-events-agent-status-store-test-fixtures'
import {
  buildWindowApi,
  stubReactSyncEffect,
  stubAuxiliaryModules
} from './ipc-events-agent-status-window-test-fixtures'

describe('useIpcEvents agent status snapshot integration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('preserves inactive, SSH, and folder routing parity in one batch', async () => {
    type RoutingCase = {
      tabId: string
      leafId: string
      ownerId: string
      payloadWorktreeId: string
      connectionId?: string
      rootless?: boolean
      expected: boolean
    }
    const folderId = 'folder-routing'
    const folderKey = folderWorkspaceKey(folderId)
    const cases: RoutingCase[] = [
      {
        tabId: 'tab-routing-inactive',
        leafId: '00000000-0000-4000-8002-000000000001',
        ownerId: 'wt-routing-local',
        payloadWorktreeId: 'wt-routing-local',
        rootless: true,
        expected: true
      },
      {
        tabId: 'tab-routing-ssh-match',
        leafId: '00000000-0000-4000-8002-000000000002',
        ownerId: 'wt-routing-ssh',
        payloadWorktreeId: 'wt-routing-ssh',
        connectionId: 'ssh-live',
        expected: true
      },
      {
        tabId: 'tab-routing-ssh-mismatch',
        leafId: '00000000-0000-4000-8002-000000000003',
        ownerId: 'wt-routing-ssh',
        payloadWorktreeId: 'wt-routing-ssh',
        connectionId: 'ssh-stale',
        expected: false
      },
      {
        tabId: 'tab-routing-hydrating',
        leafId: '00000000-0000-4000-8002-000000000004',
        ownerId: 'wt-routing-hydrating',
        payloadWorktreeId: 'wt-routing-hydrating',
        connectionId: 'ssh-hydrating',
        expected: true
      },
      {
        tabId: 'tab-routing-hydrating-mismatch',
        leafId: '00000000-0000-4000-8002-000000000005',
        ownerId: 'wt-routing-hydrating',
        payloadWorktreeId: 'wt-routing-other',
        connectionId: 'ssh-hydrating',
        expected: false
      },
      {
        tabId: 'tab-routing-folder',
        leafId: '00000000-0000-4000-8002-000000000006',
        ownerId: folderKey,
        payloadWorktreeId: folderKey,
        connectionId: 'ssh-folder-stale',
        expected: true
      }
    ]
    const tabsByWorktree: AppState['tabsByWorktree'] = {}
    const terminalLayoutsByTabId: AppState['terminalLayoutsByTabId'] = {}
    for (const entry of cases) {
      ;(tabsByWorktree[entry.ownerId] ??= []).push(
        makeTab({
          id: entry.tabId,
          worktreeId: entry.ownerId,
          title: 'Workspace',
          ptyId: `pty-${entry.tabId}`
        })
      )
      terminalLayoutsByTabId[entry.tabId] = {
        root: entry.rootless ? null : { type: 'leaf', leafId: entry.leafId },
        activeLeafId: entry.rootless ? null : entry.leafId,
        expandedLeafId: null
      }
    }
    const snapshot = cases.map((entry, index): AgentStatusSetData => ({
      paneKey: makePaneKey(entry.tabId, entry.leafId),
      worktreeId: entry.payloadWorktreeId,
      ...(entry.connectionId ? { connectionId: entry.connectionId } : {}),
      state: 'working',
      prompt: `routing case ${index}`,
      agentType: 'claude',
      receivedAt: 1_700_000_001_000 + index,
      stateStartedAt: 1_700_000_001_000 + index
    }))
    const localRepo = { ...TEST_REPO, id: 'repo-routing-local', connectionId: null }
    const sshRepo = { ...TEST_REPO, id: 'repo-routing-ssh', connectionId: 'ssh-live' }
    const store = createTestStore()
    store.setState({
      workspaceSessionReady: true,
      repos: [localRepo, sshRepo],
      worktreesByRepo: {
        [localRepo.id]: [makeWorktree({ id: 'wt-routing-local', repoId: localRepo.id })],
        [sshRepo.id]: [makeWorktree({ id: 'wt-routing-ssh', repoId: sshRepo.id })]
      },
      folderWorkspaces: [
        {
          id: folderId,
          projectGroupId: 'group-routing',
          name: 'Folder routing',
          folderPath: '/folder-routing',
          connectionId: 'ssh-folder-live',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      ],
      tabsByWorktree,
      terminalLayoutsByTabId,
      activeWorktreeId: null,
      settings: { ...store.getState().settings, terminalFontSize: 13 }
    } as Partial<AppState>)

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: store.subscribe,
        getState: store.getState,
        setState: store.setState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({ getSnapshot: vi.fn().mockResolvedValue(snapshot), onSet: () => () => {} })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    await vi.waitFor(() => {
      expect(
        cases
          .filter((entry) => entry.expected)
          .every(
            (entry) => store.getState().agentStatusByPaneKey[makePaneKey(entry.tabId, entry.leafId)]
          )
      ).toBe(true)
    })
    for (const entry of cases) {
      expect(
        store.getState().agentStatusByPaneKey[makePaneKey(entry.tabId, entry.leafId)] !== undefined
      ).toBe(entry.expected)
    }
  })

  it('projects ordered tab titles across panes in an inactive split snapshot', async () => {
    const tabId = 'tab-inactive-split'
    const worktreeId = 'wt-inactive-split'
    const waitingPaneKey = makePaneKey(tabId, '00000000-0000-4000-8000-000000000001')
    const donePaneKey = makePaneKey(tabId, '00000000-0000-4000-8000-000000000002')
    const getSnapshot = vi.fn().mockResolvedValue([
      {
        paneKey: waitingPaneKey,
        worktreeId,
        state: 'waiting',
        prompt: 'waiting turn',
        agentType: 'pi',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_700_000_000_000
      },
      {
        paneKey: donePaneKey,
        worktreeId,
        state: 'done',
        prompt: 'completed turn',
        agentType: 'pi',
        receivedAt: 1_700_000_000_001,
        stateStartedAt: 1_700_000_000_001
      }
    ] satisfies AgentStatusSetData[])
    const store = createTestStore()
    store.setState({
      workspaceSessionReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: worktreeId, repoId: TEST_REPO.id })]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: tabId, worktreeId, title: 'My Project' })]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      },
      activeWorktreeId: null,
      settings: { ...store.getState().settings, terminalFontSize: 13 }
    } as Partial<AppState>)

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: store.subscribe,
        getState: store.getState,
        setState: store.setState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    await vi.waitFor(() => {
      expect(store.getState().agentStatusByPaneKey[waitingPaneKey]?.state).toBe('waiting')
      expect(store.getState().agentStatusByPaneKey[donePaneKey]?.state).toBe('done')
      expect(store.getState().tabsByWorktree[worktreeId]?.[0]?.title).toBe('Pi ready')
    })
  })

  it('applies a burst leading-edge first, then coalesces the rest into one deferred batch', async () => {
    // Why: each live status event is its own IPC task, so N events used to pay
    // N full render passes (STA-3328 mechanism 2). The leading event must stay
    // synchronous (zero added latency); followers within the burst window must
    // apply together on one later task, in arrival order.
    vi.useFakeTimers()
    let storeState: StoreLike
    let publicationCount = 0
    const applyStatus = (paneKey: string, payload: unknown): void => {
      storeState.agentStatusByPaneKey = {
        ...(storeState.agentStatusByPaneKey as Record<string, unknown>),
        [paneKey]: payload
      }
    }
    const setAgentStatus = vi.fn((paneKey: string, payload: unknown) => {
      applyStatus(paneKey, payload)
      publicationCount += 1
    })
    const setAgentStatuses = vi.fn((updates: readonly AgentStatusBatchUpdate[]) => {
      for (const update of updates) {
        if (update.kind === 'providerSession') {
          const next = { ...(storeState.agentStatusByPaneKey as Record<string, unknown>) }
          delete next[update.paneKey]
          storeState.agentStatusByPaneKey = next
        } else {
          applyStatus(update.paneKey, update.payload)
        }
      }
      publicationCount += 1
      return updates.map(() => true)
    })
    const recordAgentProviderSession = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    storeState = buildStoreState({
      setAgentStatus,
      setAgentStatuses,
      recordAgentProviderSession,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    try {
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      if (typeof onSetListenerRef.current !== 'function') {
        throw new Error('Expected agentStatus.onSet listener to be registered')
      }
      const emit = (receivedAt: number, prompt: string): void => {
        onSetListenerRef.current!({
          paneKey: FUTURE_PANE_KEY,
          state: 'working',
          prompt,
          agentType: 'claude',
          receivedAt,
          stateStartedAt: receivedAt
        })
      }

      emit(1_700_000_000_000, 'first')
      expect(setAgentStatus).toHaveBeenCalledTimes(1)
      expect(publicationCount).toBe(1)

      emit(1_700_000_000_001, 'second')
      emit(1_700_000_000_002, 'third')
      onSetListenerRef.current({
        paneKey: FUTURE_PANE_KEY,
        state: 'working',
        prompt: 'provider identity',
        agentType: 'pi',
        providerSession: { key: 'session_id', id: 'pi-session' },
        providerSessionOnly: true,
        receivedAt: 1_700_000_000_003,
        stateStartedAt: 1_700_000_000_003
      })
      expect(setAgentStatus).toHaveBeenCalledTimes(1)
      expect(setAgentStatuses).not.toHaveBeenCalled()

      vi.advanceTimersByTime(40)
      expect(setAgentStatus).toHaveBeenCalledTimes(1)
      expect(setAgentStatuses).toHaveBeenCalledTimes(1)
      expect(setAgentStatuses.mock.calls[0][0]).toEqual([
        expect.objectContaining({
          paneKey: FUTURE_PANE_KEY,
          payload: expect.objectContaining({ prompt: 'second' })
        }),
        expect.objectContaining({
          paneKey: FUTURE_PANE_KEY,
          payload: expect.objectContaining({ prompt: 'third' })
        }),
        expect.objectContaining({
          kind: 'providerSession',
          paneKey: FUTURE_PANE_KEY,
          agent: 'pi',
          providerSession: { key: 'session_id', id: 'pi-session' }
        })
      ])
      expect(recordAgentProviderSession).not.toHaveBeenCalled()
      expect(publicationCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a live event enqueued by a synchronous batch subscriber for the next flush', async () => {
    vi.useFakeTimers()
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    let reentered = false
    const setAgentStatuses = vi.fn((updates: readonly AgentStatusUpdate[]) => {
      if (!reentered) {
        reentered = true
        onSetListenerRef.current?.({
          paneKey: FUTURE_PANE_KEY,
          state: 'working',
          prompt: 'reentered',
          agentType: 'claude',
          receivedAt: 1_700_000_000_002,
          stateStartedAt: 1_700_000_000_002
        })
      }
      return updates.map(() => true)
    })
    const storeState = buildStoreState({
      setAgentStatus,
      setAgentStatuses,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (callback) => {
          onSetListenerRef.current = callback
          return () => {}
        }
      })
    )

    try {
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      if (!onSetListenerRef.current) {
        throw new Error('Expected agentStatus.onSet listener to be registered')
      }

      onSetListenerRef.current({
        paneKey: FUTURE_PANE_KEY,
        state: 'working',
        prompt: 'leading',
        agentType: 'claude',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_700_000_000_000
      })
      onSetListenerRef.current({
        paneKey: FUTURE_PANE_KEY,
        state: 'working',
        prompt: 'queued',
        agentType: 'claude',
        receivedAt: 1_700_000_000_001,
        stateStartedAt: 1_700_000_000_001
      })

      vi.advanceTimersByTime(40)
      expect(setAgentStatuses).toHaveBeenCalledTimes(1)
      expect(setAgentStatuses.mock.calls[0][0][0].payload.prompt).toBe('queued')

      vi.advanceTimersByTime(40)
      expect(setAgentStatuses).toHaveBeenCalledTimes(2)
      expect(setAgentStatuses.mock.calls[1][0][0].payload.prompt).toBe('reentered')
    } finally {
      vi.useRealTimers()
    }
  })

  it('projects synthetic pane titles across ordered same-pane batch updates', async () => {
    vi.useFakeTimers()
    let storeState: StoreLike
    const applyStatusUpdate = (update: AgentStatusUpdate): void => {
      storeState.agentStatusByPaneKey = {
        ...(storeState.agentStatusByPaneKey as Record<string, unknown>),
        [update.paneKey]: {
          ...update.payload,
          updatedAt: update.timing?.updatedAt,
          providerSession: update.metadata?.providerSession
        }
      }
    }
    const setAgentStatus = vi.fn(
      (
        paneKey: string,
        payload: AgentStatusUpdate['payload'],
        terminalTitle?: string,
        timing?: AgentStatusUpdate['timing'],
        routing?: AgentStatusUpdate['routing'],
        metadata?: AgentStatusUpdate['metadata']
      ) => applyStatusUpdate({ paneKey, payload, terminalTitle, timing, routing, metadata })
    )
    const setAgentStatuses = vi.fn((updates: readonly AgentStatusUpdate[]) => {
      return updates.map((update) => {
        const existing = (
          storeState.agentStatusByPaneKey as Record<string, { updatedAt?: number } | undefined>
        )[update.paneKey]
        if (
          existing?.updatedAt !== undefined &&
          update.timing?.updatedAt !== undefined &&
          update.timing.updatedAt < existing.updatedAt
        ) {
          return false
        }
        applyStatusUpdate(update)
        return true
      })
    })
    const updateTabTitle = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    storeState = buildStoreState({
      setAgentStatus,
      setAgentStatuses,
      updateTabTitle,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    const updateTabTitles = vi.mocked(storeState.updateTabTitles as AppState['updateTabTitles'])

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (callback) => {
          onSetListenerRef.current = callback
          return () => {}
        }
      })
    )

    try {
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      const onSet = onSetListenerRef.current
      if (!onSet) {
        throw new Error('Expected agentStatus.onSet listener to be registered')
      }
      const emit = (
        receivedAt: number,
        state: AgentStatusSetData['state'],
        agentType?: string
      ): void => {
        onSet({
          paneKey: FUTURE_PANE_KEY,
          state,
          prompt: state,
          agentType,
          receivedAt,
          stateStartedAt: receivedAt
        })
      }

      emit(1_700_000_000_000, 'working', 'pi')
      emit(1_700_000_000_001, 'waiting', 'pi')
      emit(1_700_000_000_002, 'waiting', 'pi')
      emit(1_700_000_000_003, 'done', 'pi')
      emit(1_700_000_000_002, 'waiting', 'pi')
      vi.advanceTimersByTime(40)

      expect(setAgentStatus).toHaveBeenCalledTimes(1)
      expect(setAgentStatuses).toHaveBeenCalledTimes(1)
      expect(setAgentStatuses.mock.calls[0][0]).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ agentType: 'pi', state: 'waiting' }),
          terminalTitle: 'Pi - action required'
        }),
        expect.objectContaining({
          payload: expect.objectContaining({ agentType: 'pi', state: 'waiting' }),
          terminalTitle: 'Pi - action required'
        }),
        expect.objectContaining({
          payload: expect.objectContaining({ agentType: 'pi', state: 'done' }),
          terminalTitle: 'Pi ready'
        })
      ])
      expect(setAgentStatuses.mock.results[0].value).toEqual([true, true, true])
      expect(updateTabTitle).toHaveBeenCalledOnce()
      expect(updateTabTitle).toHaveBeenCalledWith('tab-future', 'Pi ready')
      expect(updateTabTitles).toHaveBeenCalledTimes(1)
      expect(observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
