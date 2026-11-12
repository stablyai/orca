// CLOUD-PRIMARY-DELETE: the cloud workspace's own row deletes its sandbox through the control plane.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

import { toast } from 'sonner'
import { destroyCloudPrimary } from './CloudPrimaryDeleteDialog'
import type { CloudPrimaryDeleteTarget } from '@/lib/orca-cloud/cloud-primary-delete-request'
import { resetCloudWorkspaceIdentityForTests } from '@/components/cloud-workspaces/cloud-workspace-identity'

function stub(
  destroy: () => Promise<unknown>,
  bindings: Record<string, { environmentId: string }>
) {
  vi.stubGlobal('window', {
    api: {
      cloudWorkspaces: {
        destroy: vi.fn(destroy),
        localWorkspaces: async () => [],
        environmentBindings: async () => bindings
      }
    }
  })
  return window.api.cloudWorkspaces.destroy
}

const row: CloudPrimaryDeleteTarget = {
  id: 'wt-main',
  hostId: 'runtime:env-cloud',
  displayName: 'ik-main',
  repoId: 'r',
  branch: 'main'
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  resetCloudWorkspaceIdentityForTests()
})

describe('destroyCloudPrimary', () => {
  it('destroys the paired sandbox behind the row and says so', async () => {
    const destroy = stub(async () => ({ ok: true, value: null }), {
      sbx_paired: { environmentId: 'env-cloud' }
    })
    await destroyCloudPrimary(row)
    expect(destroy).toHaveBeenCalledWith('sbx_paired')
    expect(toast.success).toHaveBeenCalledWith('Deleted ik-main')
  })

  it('a failed destroy is an error, never "Deleted"', async () => {
    stub(async () => ({ ok: false, error: 'unavailable' }), {
      sbx_paired: { environmentId: 'env-cloud' }
    })
    await destroyCloudPrimary(row)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Couldn’t delete ik-main', expect.anything())
  })

  it('no sandbox found: an error naming where to delete it, nothing destroyed', async () => {
    const destroy = stub(async () => ({ ok: true, value: null }), {})
    await destroyCloudPrimary(row)
    expect(destroy).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Couldn’t delete ik-main', {
      description: "Orca couldn't find this workspace's sandbox. Delete it from Cloud workspaces."
    })
  })
})
