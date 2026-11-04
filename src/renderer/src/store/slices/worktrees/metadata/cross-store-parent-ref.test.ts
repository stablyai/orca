import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('../../../../runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

import { mintCrossStoreParentRef } from './cross-store-parent-ref'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mint reads only id, hostId and instanceId.
const PARENT = {
  id: 'srv::/work/parent',
  hostId: 'runtime:env-1',
  instanceId: 'parent-instance'
} as unknown as Worktree

function stateWithServerInstall(installationId: string): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mint reads only these slices.
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

describe('mintCrossStoreParentRef', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
    callRuntimeRpc.mockImplementation(async (_target, method: string) =>
      method === 'status.get'
        ? { capabilities: [WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY] }
        : {
            parent: {
              installationId: 'other-install',
              workspaceKey: 'worktree:srv::/work/parent',
              instanceId: 'parent-instance'
            }
          }
    )
  })

  it("refuses a ref naming an install other than the server's verified one", async () => {
    await expect(
      mintCrossStoreParentRef(stateWithServerInstall('srv-install'), { kind: 'local' }, PARENT, {
        reparent: true
      })
    ).rejects.toThrow("Couldn't confirm the parent's machine.")
  })
})
