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
import { RuntimeHostStatusOwner } from '../../../shared/runtime-host-status-owner'
import { useStructuredAgentSessionOwnPermissionState } from './structured-agent-session-host-capability'

const owners: RuntimeHostStatusOwner[] = []
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose())
  cleanup()
  clearRuntimeCompatibilityCacheForTests()
  vi.unstubAllGlobals()
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
