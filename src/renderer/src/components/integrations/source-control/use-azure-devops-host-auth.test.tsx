// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { callRuntimeRpcResponse } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useAzureDevOpsHostAuth } from './use-azure-devops-host-auth'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpcResponse: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ invalidatePreflightStatus: () => {} }) }
}))

const target = { kind: 'environment', environmentId: 'build-server' } as const
const remote = vi.mocked(callRuntimeRpcResponse)

afterEach(() => {
  vi.resetAllMocks()
})

it('retains the confirmed remote method if the host does not acknowledge the change', async () => {
  const replies: Record<string, unknown> = {
    'settings.get': { settings: { azureDevOpsAuthMethod: 'environment' } },
    'preflight.check': { azureDevOps: { authMethod: 'environment' } },
    'settings.update': { settings: {} }
  }
  remote.mockImplementation(async (_owner, method) => ({
    ok: true,
    id: 'response',
    _meta: { runtimeId: 'runtime-a' },
    result: replies[method]
  }))

  const { result } = renderHook(() => useAzureDevOpsHostAuth(target, 42))
  await act(async () => {})
  expect(result.current.state.method).toBe('environment')
  await act(async () => result.current.save('azure-cli'))
  expect(remote).toHaveBeenCalledWith(
    target,
    'settings.update',
    { azureDevOpsAuthMethod: 'azure-cli' },
    expect.objectContaining({
      expectedEnvironmentPairingRevision: 42,
      expectedEnvironmentRuntimeId: 'runtime-a'
    })
  )
  expect(result.current.state).toMatchObject({ method: 'environment', saveFailed: true })
})

it('cannot save an authentication method to a runtime that omits it', async () => {
  remote.mockImplementation(async (_owner, method) => ({
    ok: true,
    id: 'response',
    _meta: { runtimeId: 'old-runtime' },
    result: method === 'settings.get' ? { settings: {} } : {}
  }))
  const { result } = renderHook(() => useAzureDevOpsHostAuth(target))
  await act(async () => {})
  expect(result.current.state).toMatchObject({ phase: 'unsupported', method: 'environment' })
  await act(async () => result.current.save('azure-cli'))
  expect(remote).not.toHaveBeenCalledWith(
    expect.anything(),
    'settings.update',
    expect.anything(),
    expect.anything()
  )
})
