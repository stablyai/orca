import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import { adoptRuntimeProvisionedRoot } from './runtime-provisioned-root-adoption'

describe('adoptRuntimeProvisionedRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: { ephemeralVm: { attachWorkspace: vi.fn(async () => ({})) } }
    })
  })

  it("adopts the root on the VM's server, then records the workspace on the VM runtime", async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue({
      worktree: { id: 'repo-vm::/workspace/repo', repoId: 'repo-vm' }
    })
    const result = await adoptRuntimeProvisionedRoot(
      { kind: 'environment', environmentId: 'env-vm' },
      { repoId: 'repo-vm', name: 'fix-login', baseBranch: 'main' },
      { name: 'fix-login' },
      {
        runtimeId: 'runtime-1',
        executionHostId: 'runtime:env-vm',
        expectedPath: '/workspace/repo',
        expectedRefHead: 'abc123'
      }
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-vm' },
      'worktree.adoptProvisionedRoot',
      expect.objectContaining({
        repo: 'repo-vm',
        name: 'fix-login',
        baseBranch: 'main',
        expectedPath: '/workspace/repo',
        expectedRefHead: 'abc123'
      }),
      expect.anything()
    )
    expect(window.api.ephemeralVm.attachWorkspace).toHaveBeenCalledWith({
      runtimeId: 'runtime-1',
      workspaceId: 'repo-vm::/workspace/repo'
    })
    expect(result.worktree.id).toBe('repo-vm::/workspace/repo')
  })
})
