import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildStoreState } from './ipc-events-agent-status-store-test-fixtures'
import {
  buildWindowApi,
  stubReactSyncEffect,
  stubAuxiliaryModules
} from './ipc-events-agent-status-window-test-fixtures'
import { buildSshAuthorityReconciliationHarness } from './ipc-events-ssh-authority-test-fixtures'

// Why: end-to-end exercise of startup agent-status restoration through
// useIpcEvents itself. The main process owns the durable cache; the renderer
// pulls a snapshot only after workspace tabs are ready so startup pushes
// cannot be lost while local state is still empty.
describe('useIpcEvents agent status snapshot integration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('retires the exact sleeping record after adopted or exited legacy worker recovery', async () => {
    const clearSleepingAgentSession = vi.fn()
    const setSleepingAgentAutomaticResumeBlocked = vi.fn()
    let listener:
      | ((data: { paneKey: string; resolution: 'adopted' | 'exited' }) => void)
      | undefined
    const storeState = buildStoreState({
      clearSleepingAgentSession,
      setSleepingAgentAutomaticResumeBlocked
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
        onSet: () => () => {},
        onLegacyWorkerTerminalRecovery: (callback) => {
          listener = callback
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()
    expect(listener).toBeTypeOf('function')

    listener?.({ paneKey: 'tab-adopted:leaf-adopted', resolution: 'adopted' })
    expect(clearSleepingAgentSession).toHaveBeenCalledWith('tab-adopted:leaf-adopted')
    expect(setSleepingAgentAutomaticResumeBlocked).not.toHaveBeenCalled()

    clearSleepingAgentSession.mockClear()
    listener?.({ paneKey: 'tab-exited:leaf-exited', resolution: 'exited' })
    expect(clearSleepingAgentSession).toHaveBeenCalledWith('tab-exited:leaf-exited')
    expect(setSleepingAgentAutomaticResumeBlocked).not.toHaveBeenCalled()
  })

  it.each([
    { partialAuthority: { providerEpoch: 'epoch-current' } },
    { partialAuthority: { connectionGeneration: 7 } }
  ])(
    'fills a same-watermark partial SSH authority and routes it once',
    async ({ partialAuthority }) => {
      const harness = buildSshAuthorityReconciliationHarness({
        partialAuthority,
        latestAuthority: {
          providerEpoch: 'epoch-current',
          connectionGeneration: 7
        }
      })
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()

      harness.emitPartialState()

      await vi.waitFor(() => {
        expect(harness.requestReconnect).toHaveBeenCalledOnce()
      })
      expect(harness.getState).toHaveBeenCalledOnce()
      expect(harness.setSshConnectionState).toHaveBeenCalledTimes(2)
      expect(harness.storedState()).toEqual({
        targetId: 'target-reconciliation',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: 'epoch-current',
        connectionGeneration: 7
      })
    }
  )

  it.each([
    { partialAuthority: { providerEpoch: 'epoch-conflict' } },
    { partialAuthority: { connectionGeneration: 6 } }
  ])(
    'rejects a reconciliation reply that conflicts with present authority',
    async ({ partialAuthority }) => {
      const harness = buildSshAuthorityReconciliationHarness({
        partialAuthority,
        latestAuthority: {
          providerEpoch: 'epoch-current',
          connectionGeneration: 7
        }
      })
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()

      harness.emitPartialState()

      await vi.waitFor(() => {
        expect(harness.getState).toHaveBeenCalledOnce()
      })
      await Promise.resolve()
      expect(harness.requestReconnect).not.toHaveBeenCalled()
      expect(harness.setSshConnectionState).toHaveBeenCalledOnce()
      expect(harness.storedState()).toEqual(
        expect.objectContaining({
          targetId: 'target-reconciliation',
          ...partialAuthority
        })
      )
    }
  )

  it.each([
    { enabled: true, expectedRoute: ['request'] },
    {
      enabled: false,
      expectedRoute: ['replace', 'invalidate', 'retry', 'capture', 'prepare']
    }
  ])(
    'routes a changed direct SSH authority through the enabled=$enabled path',
    async ({ enabled, expectedRoute }) => {
      const order: string[] = []
      let sshStateListener: ((data: { targetId: string; state: unknown }) => void) | undefined
      const oldState = {
        targetId: 'target-a',
        status: 'connected' as const,
        error: null,
        reconnectAttempt: 0,
        providerEpoch: 'epoch-old',
        connectionGeneration: 1
      }
      const nextState = {
        ...oldState,
        providerEpoch: 'epoch-new',
        connectionGeneration: 2
      }
      const storeState = buildStoreState({
        sshTargetLabels: new Map([['target-a', 'Target A']]),
        sshConnectionStates: new Map([['target-a', oldState]]),
        setSshConnectionState: (targetId: string, state: unknown) => {
          ;(storeState.sshConnectionStates as Map<string, unknown>).set(targetId, state)
        },
        invalidateStaleDirectSshTargetPtyBindings: () => {
          order.push('invalidate')
          return 1
        },
        retryDirectSshTargetPanes: () => {
          order.push('retry')
          return 1
        },
        setSshTargetsMetadata: vi.fn(),
        setRemovedSshTargetLabels: vi.fn(),
        setRemoteWorkspaceSyncStatus: vi.fn(),
        clearRemoteDetectedAgents: vi.fn(),
        clearDirectSshTargetPtyBindings: vi.fn(),
        clearRemovedSshTargetState: vi.fn()
      })
      const coordinator = {
        requestReconnect: vi.fn(async () => {
          order.push('request')
          return { status: 'complete' }
        }),
        replaceAuthority: vi.fn(() => {
          order.push('replace')
        }),
        prepareOnly: vi.fn(async () => {
          order.push('prepare')
          return { token: null }
        }),
        correctUnboundTerminals: vi.fn(() => 0),
        finalizeHydratedTerminals: vi.fn(() => 0),
        invalidate: vi.fn(),
        stop: vi.fn()
      }
      const capturePreparationInput = vi.fn(async (authority, reason) => {
        order.push('capture')
        return {
          ...authority,
          reason,
          catalogRevision: 1,
          repoRefs: [],
          authorityRequirement: 'required'
        }
      })

      stubReactSyncEffect()
      stubAuxiliaryModules()
      vi.doMock('../store', () => ({
        useAppStore: {
          subscribe: vi.fn(() => () => {}),
          getState: () => storeState
        }
      }))
      vi.doMock('./direct-ssh-reconnect-rollout', () => ({
        isDirectSshReconnectCoordinatorRoutingEnabled: () => enabled
      }))
      vi.doMock('./direct-ssh-worktree-refresh-scheduler', () => ({
        createDirectSshWorktreeRefreshScheduler: () => ({
          stop: vi.fn(),
          disposeProvider: vi.fn()
        })
      }))
      vi.doMock('./direct-ssh-host-hydration', () => ({
        createDirectSshHostHydration: () => ({
          capturePreparationInput,
          readHostScopedLineage: vi.fn(),
          isPreparationTokenCurrent: vi.fn(() => true),
          stop: vi.fn()
        })
      }))
      vi.doMock('./direct-ssh-reconnect-coordinator', () => ({
        createDirectSshReconnectCoordinator: () => coordinator
      }))
      vi.doMock('@/lib/direct-ssh-reconnect-product-telemetry', () => ({
        createDirectSshReconnectProductTelemetryAdapter: vi.fn()
      }))
      vi.stubGlobal(
        'window',
        buildWindowApi({
          onSet: () => () => {},
          ssh: {
            onStateChanged: (listener: (data: { targetId: string; state: unknown }) => void) => {
              sshStateListener = listener
              return () => {}
            }
          }
        })
      )

      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      sshStateListener?.({ targetId: 'target-a', state: nextState })
      await Promise.resolve()
      await Promise.resolve()

      expect(order).toEqual(expectedRoute)
      if (enabled) {
        expect(coordinator.requestReconnect).toHaveBeenCalledOnce()
        expect(coordinator.prepareOnly).not.toHaveBeenCalled()
      } else {
        expect(coordinator.requestReconnect).not.toHaveBeenCalled()
        expect(coordinator.replaceAuthority).toHaveBeenCalledOnce()
        expect(coordinator.prepareOnly).toHaveBeenCalledOnce()
      }
    }
  )

  it('does not let initial SSH port snapshots overwrite newer push events', async () => {
    const targetId = 'target-ports'
    const secondTargetId = 'target-ports-second'
    const rejectingTargetId = 'target-ports-rejecting'
    const partialTargetId = 'target-ports-partial'
    const connectedState = {
      targetId,
      status: 'connected' as const,
      error: null,
      reconnectAttempt: 0,
      providerEpoch: 'epoch-ports',
      connectionGeneration: 3
    }
    const secondConnectedState = {
      ...connectedState,
      targetId: secondTargetId,
      providerEpoch: 'epoch-ports-second'
    }
    const rejectingConnectedState = {
      ...connectedState,
      targetId: rejectingTargetId,
      providerEpoch: 'epoch-ports-rejecting'
    }
    const partialConnectedState = {
      ...connectedState,
      targetId: partialTargetId,
      providerEpoch: null,
      connectionGeneration: undefined
    }
    const reconciledPartialState = {
      ...connectedState,
      targetId: partialTargetId,
      providerEpoch: 'epoch-ports-partial',
      connectionGeneration: 4
    }
    const liveForward = {
      id: 'forward-live',
      targetId,
      localPort: 17860,
      remoteHost: '127.0.0.1',
      remotePort: 7860,
      status: 'active' as const
    }
    const secondForward = {
      ...liveForward,
      id: 'forward-second',
      targetId: secondTargetId,
      localPort: 17861,
      remotePort: 7861
    }
    const rejectingTargetForward = {
      ...liveForward,
      id: 'forward-rejecting-target',
      targetId: rejectingTargetId,
      localPort: 17862,
      remotePort: 7862
    }
    const partialTargetForward = {
      ...liveForward,
      id: 'forward-partial-target',
      targetId: partialTargetId,
      localPort: 17863,
      remotePort: 7863
    }
    const detectedPort = {
      port: 7860,
      pid: 42,
      processName: 'python',
      command: 'python -m http.server 7860'
    }
    const secondDetectedPort = {
      ...detectedPort,
      port: 7861,
      pid: 43,
      command: 'python -m http.server 7861'
    }
    let resolveForwards: (value: []) => void = () => {}
    let resolveDetected: (value: (typeof detectedPort)[]) => void = () => {}
    let resolveSecondForwards: (value: (typeof secondForward)[]) => void = () => {}
    let resolveSecondDetected: (value: []) => void = () => {}
    const forwardsSnapshot = new Promise<[]>((resolve) => {
      resolveForwards = resolve
    })
    const detectedSnapshot = new Promise<(typeof detectedPort)[]>((resolve) => {
      resolveDetected = resolve
    })
    const secondForwardsSnapshot = new Promise<(typeof secondForward)[]>((resolve) => {
      resolveSecondForwards = resolve
    })
    const secondDetectedSnapshot = new Promise<[]>((resolve) => {
      resolveSecondDetected = resolve
    })
    const listPortForwards = vi.fn(({ targetId: requestedTargetId }: { targetId: string }) => {
      if (requestedTargetId === rejectingTargetId) {
        return Promise.resolve([rejectingTargetForward])
      }
      if (requestedTargetId === partialTargetId) {
        return Promise.resolve([partialTargetForward])
      }
      return requestedTargetId === targetId ? forwardsSnapshot : secondForwardsSnapshot
    })
    const listDetectedPorts = vi.fn(({ targetId: requestedTargetId }: { targetId: string }) => {
      if (requestedTargetId === rejectingTargetId) {
        return Promise.reject(new Error('detected snapshot unavailable'))
      }
      if (requestedTargetId === partialTargetId) {
        return Promise.resolve([])
      }
      return requestedTargetId === targetId ? detectedSnapshot : secondDetectedSnapshot
    })
    let forwardListener:
      | ((data: { targetId: string; forwards: (typeof liveForward)[] }) => void)
      | undefined
    let detectedListener:
      | ((data: { targetId: string; ports: (typeof detectedPort)[] }) => void)
      | undefined
    const setPortForwards = vi.fn()
    const setDetectedPorts = vi.fn()
    const sshConnectionStates = new Map<
      string,
      | typeof connectedState
      | typeof secondConnectedState
      | typeof rejectingConnectedState
      | typeof partialConnectedState
      | typeof reconciledPartialState
    >()
    const storeState = buildStoreState({
      sshTargetLabels: new Map([
        [targetId, 'Ports Target'],
        [secondTargetId, 'Second Ports Target'],
        [rejectingTargetId, 'Rejecting Ports Target'],
        [partialTargetId, 'Partial Ports Target']
      ]),
      sshConnectionStates,
      setSshConnectionState: (
        nextTargetId: string,
        state:
          | typeof connectedState
          | typeof secondConnectedState
          | typeof rejectingConnectedState
          | typeof partialConnectedState
          | typeof reconciledPartialState
      ) => {
        sshConnectionStates.set(nextTargetId, state)
      },
      setPortForwards,
      setDetectedPorts,
      setSshTargetsMetadata: vi.fn(),
      setRemovedSshTargetLabels: vi.fn(),
      setRemoteWorkspaceSyncStatus: vi.fn(),
      fetchRuntimeEnvironmentRepos: vi.fn(async () => []),
      fetchWorktreeLineage: vi.fn(async () => undefined),
      clearRemoteDetectedAgents: vi.fn(),
      clearDirectSshTargetPtyBindings: vi.fn(),
      clearRemovedSshTargetState: vi.fn(),
      invalidateStaleDirectSshTargetPtyBindings: vi.fn(() => 0),
      retryDirectSshTargetPanes: vi.fn(() => 0)
    })
    const coordinator = {
      requestReconnect: vi.fn(async () => ({ status: 'complete' })),
      replaceAuthority: vi.fn(),
      prepareOnly: vi.fn(async () => ({ token: null })),
      correctUnboundTerminals: vi.fn(() => 0),
      finalizeHydratedTerminals: vi.fn(() => 0),
      invalidate: vi.fn(),
      stop: vi.fn()
    }
    let partialTargetStateCalls = 0

    stubReactSyncEffect()
    stubAuxiliaryModules()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    vi.doMock('./direct-ssh-reconnect-rollout', () => ({
      isDirectSshReconnectCoordinatorRoutingEnabled: () => true
    }))
    vi.doMock('./direct-ssh-worktree-refresh-scheduler', () => ({
      createDirectSshWorktreeRefreshScheduler: () => ({
        stop: vi.fn(),
        disposeProvider: vi.fn()
      })
    }))
    vi.doMock('./direct-ssh-host-hydration', () => ({
      createDirectSshHostHydration: () => ({
        capturePreparationInput: vi.fn(),
        readHostScopedLineage: vi.fn(),
        isPreparationTokenCurrent: vi.fn(() => true),
        stop: vi.fn()
      })
    }))
    vi.doMock('./direct-ssh-reconnect-coordinator', () => ({
      createDirectSshReconnectCoordinator: () => coordinator
    }))
    vi.doMock('@/lib/direct-ssh-reconnect-product-telemetry', () => ({
      createDirectSshReconnectProductTelemetryAdapter: vi.fn()
    }))
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: () => () => {},
        ssh: {
          listTargets: () =>
            Promise.resolve([
              { id: rejectingTargetId, label: 'Rejecting Ports Target' },
              { id: partialTargetId, label: 'Partial Ports Target' },
              { id: targetId, label: 'Ports Target' },
              { id: secondTargetId, label: 'Second Ports Target' }
            ]),
          listRemovedTargetLabels: () => Promise.resolve({}),
          getState: ({ targetId: requestedTargetId }: { targetId: string }) => {
            if (requestedTargetId === partialTargetId) {
              partialTargetStateCalls += 1
              return Promise.resolve(
                partialTargetStateCalls === 1 ? partialConnectedState : reconciledPartialState
              )
            }
            return Promise.resolve(
              requestedTargetId === rejectingTargetId
                ? rejectingConnectedState
                : requestedTargetId === targetId
                  ? connectedState
                  : secondConnectedState
            )
          },
          listPortForwards,
          listDetectedPorts,
          onPortForwardsChanged: (
            listener: (data: { targetId: string; forwards: (typeof liveForward)[] }) => void
          ) => {
            forwardListener = listener
            return () => {}
          },
          onDetectedPortsChanged: (
            listener: (data: { targetId: string; ports: (typeof detectedPort)[] }) => void
          ) => {
            detectedListener = listener
            return () => {}
          }
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    await vi.waitFor(() => {
      expect(forwardListener).toBeTypeOf('function')
      expect(detectedListener).toBeTypeOf('function')
      expect(partialTargetStateCalls).toBe(2)
      expect(sshConnectionStates.get(partialTargetId)).toEqual(reconciledPartialState)
      expect(listPortForwards).toHaveBeenCalledTimes(4)
      expect(listDetectedPorts).toHaveBeenCalledTimes(4)
      expect(
        setPortForwards.mock.calls.filter(
          ([requestedTargetId]) => requestedTargetId === rejectingTargetId
        )
      ).toEqual([[rejectingTargetId, [rejectingTargetForward]]])
      expect(
        setPortForwards.mock.calls.filter(
          ([requestedTargetId]) => requestedTargetId === partialTargetId
        )
      ).toEqual([[partialTargetId, [partialTargetForward]]])
    })
    forwardListener?.({ targetId, forwards: [liveForward] })
    resolveForwards([])
    resolveDetected([detectedPort])

    await vi.waitFor(() => {
      expect(
        setPortForwards.mock.calls.filter(([requestedTargetId]) => requestedTargetId === targetId)
      ).toEqual([[targetId, [liveForward]]])
      expect(
        setDetectedPorts.mock.calls.filter(([requestedTargetId]) => requestedTargetId === targetId)
      ).toEqual([[targetId, [detectedPort]]])
      expect(listPortForwards).toHaveBeenCalledTimes(4)
      expect(listDetectedPorts).toHaveBeenCalledTimes(4)
    })
    forwardListener?.({ targetId, forwards: [liveForward] })
    detectedListener?.({ targetId: secondTargetId, ports: [secondDetectedPort] })
    resolveSecondForwards([secondForward])
    resolveSecondDetected([])

    await vi.waitFor(() => {
      expect(
        setPortForwards.mock.calls.filter(
          ([requestedTargetId]) => requestedTargetId === secondTargetId
        )
      ).toEqual([[secondTargetId, [secondForward]]])
      expect(
        setDetectedPorts.mock.calls.filter(
          ([requestedTargetId]) => requestedTargetId === secondTargetId
        )
      ).toEqual([[secondTargetId, [secondDetectedPort]]])
    })
  })
})
