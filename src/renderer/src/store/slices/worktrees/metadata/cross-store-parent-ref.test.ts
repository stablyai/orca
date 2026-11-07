import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('../../../../runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc
}))

import { buildCrossStoreParentRef } from './cross-store-parent-ref'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ref reads only id, hostId and instanceId.
const PARENT = {
  id: 'srv::/work/parent',
  hostId: 'runtime:env-1',
  instanceId: 'parent-instance'
} as unknown as Worktree

function stateWithServerInstall(installationId: string): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ref reads only these slices.
  return {
    runtimeEnvironments: [],
    crossStoreLineageByStoreKey: {},
    ownLineageInstallationId: 'mac-install',
    removedRuntimeEnvironmentIds: new Set(),
    runtimeStatusByEnvironmentId: new Map([
      ['env-1', { status: { hostDescriptor: { installationId } }, checkedAt: 1 }]
    ])
  } as unknown as AppState
}

describe('buildCrossStoreParentRef', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
    callRuntimeRpc.mockResolvedValue({
      capabilities: [WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY]
    })
  })

  it("names the parent by its server's verified install", async () => {
    await expect(
      buildCrossStoreParentRef(stateWithServerInstall('srv-install'), { kind: 'local' }, PARENT)
    ).resolves.toEqual({
      installationId: 'srv-install',
      workspaceKey: 'worktree:srv::/work/parent',
      instanceId: 'parent-instance'
    })
  })
})
