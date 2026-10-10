import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc, supportsCapability } = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  supportsCapability: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability: supportsCapability
}))

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import {
  killWorkspacePortOnExecutionHost,
  scanWorkspacePortsOnExecutionHost,
  WORKSPACE_PORTS_SERVER_SSH_UPDATE_REASON,
  type HostScopedPortHost
} from './workspace-port-scan-client'
import { WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const host: HostScopedPortHost = {
  route: { target: { kind: 'environment', environmentId: 'env-e' }, at: 'ssh:t' },
  executionHostId: 'ssh:t',
  worktreeId: 'repo-1::/srv/w'
}

const rowOnT = {
  id: '0.0.0.0:3020:4242',
  kind: 'external',
  bindHost: '0.0.0.0',
  connectHost: '127.0.0.1',
  port: 3020,
  pid: 4242,
  protocol: 'unknown'
}

beforeEach(() => {
  callRuntimeRpc.mockReset()
  supportsCapability.mockReset()
  supportsCapability.mockResolvedValue(true)
})

describe('scanWorkspacePortsOnExecutionHost', () => {
  it('asks the server to scan the workspace host and keeps the host it names', async () => {
    callRuntimeRpc.mockResolvedValue({
      executionHostId: 'ssh:t',
      platform: 'linux',
      scannedAt: 1,
      ports: [rowOnT]
    })

    const scan = await scanWorkspacePortsOnExecutionHost(host)

    expect(supportsCapability).toHaveBeenCalledWith(
      'env-e',
      WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      host.route.target,
      'workspacePorts.scanHost',
      { worktree: 'id:repo-1::/srv/w' },
      expect.objectContaining({ timeoutMs: 15_000 })
    )
    expect(scan).toMatchObject({ executionHostId: 'ssh:t', ports: [rowOnT] })
    expect(scan.unavailableReason).toBeUndefined()
  })

  it('never asks an older server, whose scan would show the server instead of its SSH host', async () => {
    supportsCapability.mockResolvedValue(false)

    const scan = await scanWorkspacePortsOnExecutionHost(host)

    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(scan).toMatchObject({
      executionHostId: 'ssh:t',
      ports: [],
      unavailableReason: WORKSPACE_PORTS_SERVER_SSH_UPDATE_REASON
    })
  })

  it('says "update server" when the server lacks the method despite advertising it', async () => {
    callRuntimeRpc.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'r',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'runtime-e' }
      })
    )

    await expect(scanWorkspacePortsOnExecutionHost(host)).resolves.toMatchObject({
      ports: [],
      unavailableReason: WORKSPACE_PORTS_SERVER_SSH_UPDATE_REASON
    })
  })

  it("scans a recipe VM through this app's own runtime without a capability probe", async () => {
    const recipeVm: HostScopedPortHost = {
      route: { target: { kind: 'local' }, at: 'ssh:runtime-ssh-vm1' },
      executionHostId: 'ssh:runtime-ssh-vm1',
      worktreeId: 'repo-1::/srv/w'
    }
    callRuntimeRpc.mockResolvedValue({
      executionHostId: 'ssh:runtime-ssh-vm1',
      platform: 'unknown',
      scannedAt: 1,
      ports: [],
      unavailableReason: 'The SSH host is not connected.'
    })

    const scan = await scanWorkspacePortsOnExecutionHost(recipeVm)

    expect(supportsCapability).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'workspacePorts.scanHost',
      { worktree: 'id:repo-1::/srv/w' },
      expect.anything()
    )
    // An unreachable VM stays "could not look", never an empty "no ports".
    expect(scan.unavailableReason).toBe('The SSH host is not connected.')
  })

  it("drops rows the server scanned on a host other than the workspace's", async () => {
    callRuntimeRpc.mockResolvedValue({
      executionHostId: 'local',
      platform: 'linux',
      scannedAt: 1,
      ports: [rowOnT]
    })

    const scan = await scanWorkspacePortsOnExecutionHost(host)

    expect(scan.ports).toEqual([])
    expect(scan.unavailableReason).toMatch(/different host/)
  })
})

describe('killWorkspacePortOnExecutionHost', () => {
  it('stops a row only through the server, naming the host the row was scanned on', async () => {
    callRuntimeRpc.mockResolvedValue({ ok: true })

    await expect(
      killWorkspacePortOnExecutionHost(host, { scannedHostId: 'ssh:t', pid: 4242, port: 3020 })
    ).resolves.toEqual({ ok: true })

    // Same pid and port may be listening on the server itself; the old repo-scoped kill would
    // signal that one, so it must never be used for a row from the SSH host.
    expect(callRuntimeRpc).toHaveBeenCalledOnce()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      host.route.target,
      'workspacePorts.killHost',
      { worktree: 'id:repo-1::/srv/w', executionHostId: 'ssh:t', pid: 4242, port: 3020 },
      expect.objectContaining({ timeoutMs: 15_000 })
    )
  })

  it('reports "update server" instead of falling back to the server-local kill', async () => {
    callRuntimeRpc.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'r',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'runtime-e' }
      })
    )

    await expect(
      killWorkspacePortOnExecutionHost(host, { scannedHostId: 'ssh:t', pid: 4242, port: 3020 })
    ).resolves.toEqual({ ok: false, reason: WORKSPACE_PORTS_SERVER_SSH_UPDATE_REASON })
    expect(callRuntimeRpc).toHaveBeenCalledOnce()
  })
})
