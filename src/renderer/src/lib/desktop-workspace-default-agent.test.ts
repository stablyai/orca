import { beforeEach, expect, it, vi } from 'vitest'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'
import { resolveDesktopWorkspaceDefaultAgent } from './desktop-workspace-default-agent'

const mocks = vi.hoisted(() => ({
  localCapabilities: vi.fn(),
  remoteCapability: vi.fn(),
  call: vi.fn()
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: mocks.localCapabilities
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.remoteCapability,
  callRuntimeRpc: mocks.call
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.localCapabilities.mockResolvedValue([PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY])
  mocks.remoteCapability.mockResolvedValue(true)
  mocks.call.mockResolvedValue({ agent: 'codex', source: 'project' })
})

it('refuses direct SSH and unresolved owners without consulting the local runtime', async () => {
  for (const hostId of ['ssh:devbox', 'runtime:unresolved-owner'] as const) {
    await expect(resolveDesktopWorkspaceDefaultAgent({ repo: 'B', hostId })).rejects.toThrow(
      'cannot be served'
    )
  }
  expect(mocks.localCapabilities).not.toHaveBeenCalled()
  expect(mocks.call).not.toHaveBeenCalled()
})

it('resolves on the selected runtime and refuses an older host before RPC dispatch', async () => {
  await expect(
    resolveDesktopWorkspaceDefaultAgent({ repo: 'B', hostId: 'runtime:remote' })
  ).resolves.toEqual({ agent: 'codex', source: 'project' })
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'remote' },
    'agent.resolveDefault',
    { repo: 'B', repoHostId: 'runtime:remote' }
  )
  expect(mocks.localCapabilities).not.toHaveBeenCalled()
  mocks.call.mockClear()
  mocks.remoteCapability.mockResolvedValue(false)
  await expect(
    resolveDesktopWorkspaceDefaultAgent({ repo: 'B', hostId: 'runtime:remote' })
  ).rejects.toThrow('Update the target Orca host')
  expect(mocks.call).not.toHaveBeenCalled()
})
