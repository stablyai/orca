// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as HostCapability from './structured-agent-session-host-capability'
// The separate whole-host publication contract covers the status feed; isolate capability display here.
vi.mock('../components/native-chat/StructuredAgentSessionStatusBridge', () => ({
  useStructuredAgentSessionStatusSummary: () => ({ summary: null, observation: 0 })
}))
// Existing non-Own action gates have their own unchanged request/recovery contracts.
vi.mock('./structured-agent-session-host-capability', async (original) => ({
  ...(await original<typeof HostCapability>()),
  useStructuredAgentSessionHostCapability: () => false
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('./structured-agent-session-client', () => ({
  callStructuredAgentSession: async () => ({
    models: [{ id: 'model-a', label: 'Model A', isDefault: true, efforts: [] }],
    current: { model: 'model-a', permissionMode: 'ask', reportedPermissionMode: 'ask' }
  }),
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
}))
import { useStructuredAgentSessionOptions } from '../components/native-chat/use-structured-agent-session-options'
import { useAppStore } from '@/store'
import { AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY } from '../../../shared/agent-session-permission-modes-capability'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import * as runtimeRpc from './runtime-rpc-client'
import { RuntimeHostStatusOwner } from '../../../shared/runtime-host-status-owner'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import {
  useStructuredAgentSessionOwnPermissionState,
  useStructuredAgentSessionHostEditsQueuedSkills
} from './structured-agent-session-host-capability'

const owners: RuntimeHostStatusOwner[] = []
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose())
  cleanup()
  clearRuntimeCompatibilityCacheForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([10, 100])(
  'enables %s mounted consumers from the existing connection owner',
  async (count) => {
    useAppStore.setState({
      runtimeEnvironments: [
        {
          id: 'host',
          name: 'host',
          createdAt: 1,
          updatedAt: 1,
          pairingRevision: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'host'
        }
      ],
      runtimeStatusByEnvironmentId: new Map()
    })
    let response = Promise.withResolvers<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
    const request = vi.fn(() => response.promise)
    const owner = new RuntimeHostStatusOwner({
      environmentId: 'host',
      pairingRevision: 1,
      request,
      verified: () => false,
      publish: (snapshot) => useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot)
    })
    owners.push(owner)
    const call = vi.fn()
    vi.stubGlobal('window', { document, api: { runtimeEnvironments: { call } } })
    let renderCalls = 0
    const target = { kind: 'environment', environmentId: 'host' } as const
    const views = Array.from({ length: count }, (_, index) =>
      renderHook(() => {
        const before = call.mock.calls.length
        const options = useStructuredAgentSessionOptions({
          agent: 'claude',
          sessionId: `composer-${index}`,
          target,
          fence: 1,
          transportEnabled: true,
          isVisible: true,
          providerVisible: true,
          turnId: null,
          unloadedTurnRevisions: undefined,
          hostOptionStamp: 'model-a|ask',
          mutate: vi.fn(async () => null)
        })
        const state = useStructuredAgentSessionOwnPermissionState(target)
        renderCalls += call.mock.calls.length - before
        return { state, picker: options.optionSnapshot.find((row) => row.id === 'permissionMode') }
      })
    )
    expect(renderCalls).toBe(0)
    expect(call).not.toHaveBeenCalled()
    act(() => {
      owner.connectionChanged('ready')
      owner.activate()
    })
    expect(request).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(views.every((view) => view.result.current.picker?.settable === false)).toBe(true)
    )
    expect(views.map((view) => view.result.current.state)).toEqual(Array(count).fill('unknown'))
    const good = createCompatibleRuntimeStatusResponse('host')
    if (!good.ok) {
      throw new Error('expected successful fixture')
    }
    good.result.capabilities = (good.result.capabilities ?? []).filter(
      (capability) => capability !== AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
    )
    await act(async () => {
      response.resolve(good)
      await response.promise
    })
    expect(views.map((view) => view.result.current.state)).toEqual(Array(count).fill('unsupported'))
    expect(views.every((view) => view.result.current.picker?.settable)).toBe(true)
    response = Promise.withResolvers<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
    act(() => owner.connectionChanged('disconnected'))
    expect(views.map((view) => view.result.current.state)).toEqual(Array(count).fill('unsupported'))
    act(() => owner.connectionChanged('ready'))
    const upgraded = structuredClone(good)
    upgraded.result.capabilities = [
      ...(good.result.capabilities ?? []),
      AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
    ]
    await act(async () => {
      response.resolve(upgraded)
      await response.promise
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(views.map((view) => view.result.current.state)).toEqual(Array(count).fill('supported'))
    expect(
      views.every((view) => {
        const picker = view.result.current.picker
        return (
          picker?.settable === true &&
          picker.valueSource === 'reported' &&
          picker.description === 'Ask for approval' &&
          picker.kind.type === 'select' &&
          picker.kind.currentValue === 'ask' &&
          picker.kind.choices.some((choice) => choice.value === 'ask') &&
          !picker.kind.choices.some((choice) => choice.value === 'own')
        )
      })
    ).toBe(true)
    expect(call).not.toHaveBeenCalled()
  }
)

it.each([10, 100])(
  'does not rerender %s local and other-host consumers for unrelated status changes',
  (count) => {
    const unrelated = createCompatibleRuntimeStatusResponse('other')
    const own = createCompatibleRuntimeStatusResponse('host')
    if (!unrelated.ok || !own.ok) {
      throw new Error('expected successful fixture')
    }
    const statuses = (otherStatus: typeof unrelated.result | null) =>
      new Map<string, RuntimeEnvironmentStatus>([
        ['host', { status: own.result, checkedAt: 1 }],
        ['other', { status: otherStatus, checkedAt: 1 }]
      ])
    useAppStore.setState({ runtimeStatusByEnvironmentId: statuses(null) })
    let renders = 0
    const targets = [{ kind: 'local' }, { kind: 'environment', environmentId: 'host' }] as const
    const views = Array.from({ length: count }, (_, index) =>
      renderHook(() => {
        const target = targets[index % targets.length]
        renders += 1
        return useStructuredAgentSessionOwnPermissionState(target)
      })
    )
    const before = renders
    for (let flip = 0; flip < 10; flip += 1) {
      act(() =>
        useAppStore.setState({
          runtimeStatusByEnvironmentId: statuses(flip % 2 === 0 ? unrelated.result : null)
        })
      )
    }
    expect(renders - before).toBe(0)
    const hostState = views[1].result.current
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>([
          [
            'host',
            {
              status: {
                ...own.result,
                capabilities:
                  hostState === 'supported' ? [] : [AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY]
              },
              checkedAt: 2
            }
          ]
        ])
      })
    )
    expect(views[1].result.current).toBe(hostState === 'supported' ? 'unsupported' : 'supported')
  }
)

it.each([10, 100])(
  'isolates mounted skills capability consumers across %i other hosts with separate upstream counts',
  async (count) => {
    const hosts = ['own', ...Array.from({ length: count }, (_, i) => `idle-${i}`)]
    const statuses = new Map<string, RuntimeEnvironmentStatus>(
      hosts.map((host) => [host, { status: null, checkedAt: 1, hostContactEpoch: 0 }])
    )
    useAppStore.setState({ runtimeStatusByEnvironmentId: statuses })
    let supported = false
    const probe = vi
      .spyOn(runtimeRpc, 'runtimeEnvironmentSupportsCapability')
      .mockImplementation(async () => supported)
    let upstream = 0
    const subscribe = useAppStore.subscribe
    vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) =>
      subscribe((state, previous) => {
        upstream++
        listener(state, previous)
      })
    )
    const renders = hosts.map(() => 0)
    const views = hosts.map((host, i) =>
      renderHook(() => {
        renders[i]++
        return useStructuredAgentSessionHostEditsQueuedSkills({
          kind: 'environment',
          environmentId: host
        })
      })
    )
    await act(async () => {})
    expect(probe).toHaveBeenCalledTimes(hosts.length)
    renders.fill(0)
    probe.mockClear()
    upstream = 0
    await act(async () =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          ...statuses,
          ['unobserved', { status: null, checkedAt: 1, hostContactEpoch: 1 }]
        ])
      })
    )
    expect(upstream).toBe(hosts.length)
    expect(renders).toEqual(hosts.map(() => 0))
    expect(probe).not.toHaveBeenCalled()
    supported = true
    upstream = 0
    await act(async () =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          ...statuses,
          ['own', { status: null, checkedAt: 2, hostContactEpoch: 1 }]
        ])
      })
    )
    expect(upstream).toBe(hosts.length)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0][0]).toBe('own')
    expect(views[0].result.current).toBe(true)
    expect(renders[0]).toBeGreaterThan(0)
    expect(renders.slice(1)).toEqual(hosts.slice(1).map(() => 0))
    views.forEach((view) => view.unmount())
    probe.mockClear()
    upstream = 0
    await act(async () => useAppStore.setState({ runtimeStatusByEnvironmentId: statuses }))
    expect(upstream).toBe(0)
    expect(probe).not.toHaveBeenCalled()
  }
)
