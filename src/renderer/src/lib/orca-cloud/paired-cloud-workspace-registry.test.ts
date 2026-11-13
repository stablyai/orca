// PAIRED-STATUS: a paired cloud workspace's own row gets its status through main's paired path,
// without joining the owned ids (owned-only flows such as the VM sleep key on those).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}), subscribe: () => () => {} } }))

import {
  pairedCloudWorkspacesFromState,
  setPairedCloudWorkspaces
} from './paired-cloud-workspace-registry'
import {
  cloudWorkspaceTarget,
  getCloudWorkspaceSnapshot,
  refreshCloudWorkspaceStatus,
  seedCloudWorkspaceSnapshot
} from './orca-cloud-workspace-store'

const ready = {
  state: 'ready' as const,
  metrics: null,
  uptimeMs: 1000,
  usage: { totalMs: 1000, centsPerHour: 75, costCents: 0 },
  archive: null,
  checkedAt: 1
}

const PAIRED_ROW = 'push-test::/workspace/orca-sandbox-push-test'

describe('which rows are paired cloud workspaces', () => {
  const environments = [{ id: 'env-gh', orcaCloudPaired: true as const }, { id: 'env-box' }]
  const local = { id: 'local::/repo', hostId: 'local', isMainWorktree: true }
  const box = { id: 'box::/srv/app', hostId: 'runtime:env-box', isMainWorktree: true }

  it("a GitHub-only workspace: its server's main checkout, and nothing else", () => {
    expect(
      pairedCloudWorkspacesFromState({
        runtimeEnvironments: environments,
        worktreesByRepo: {
          gh: [{ id: PAIRED_ROW, hostId: 'runtime:env-gh', isMainWorktree: true, branch: 'main' }],
          box: [box],
          local: [local]
        }
      })
    ).toEqual({ [PAIRED_ROW]: 'env-gh' })
  })

  it("a teammate's shared workspace: its linked worktree, never the hidden base checkout (PAIRED-REGISTRY-ROW)", () => {
    const linked = 'gh::/home/vercel/ws/Hello-World/endpass-n44'
    expect(
      pairedCloudWorkspacesFromState({
        runtimeEnvironments: environments,
        worktreesByRepo: {
          gh: [
            { id: PAIRED_ROW, hostId: 'runtime:env-gh', isMainWorktree: true, branch: 'master' },
            { id: linked, hostId: 'runtime:env-gh', isMainWorktree: false, branch: 'endpass-n44' }
          ],
          box: [box],
          local: [local]
        }
      })
    ).toEqual({ [linked]: 'env-gh' })
  })

  it("leaves this computer's own rows and other servers alone", () => {
    expect(
      pairedCloudWorkspacesFromState({
        runtimeEnvironments: environments,
        worktreesByRepo: {
          local: [local, { id: 'local::/wt', hostId: 'local', isMainWorktree: false }],
          box: [box, { id: 'box::/srv/wt', hostId: 'runtime:env-box', isMainWorktree: false }]
        }
      })
    ).toEqual({})
  })
})

describe('a paired workspace in the cloud workspace store', () => {
  let getStatus: ReturnType<typeof vi.fn>
  beforeEach(() => {
    seedCloudWorkspaceSnapshot({})
    getStatus = vi.fn(async () => ({ ok: true, value: ready }))
    vi.stubGlobal('window', { api: { orcaCloudWorkspace: { getStatus } } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads its status by naming its server, and stays out of the owned ids', async () => {
    setPairedCloudWorkspaces({ [PAIRED_ROW]: 'env-gh' })
    await refreshCloudWorkspaceStatus(PAIRED_ROW)
    expect(getStatus).toHaveBeenCalledWith({ workspaceId: PAIRED_ROW, environmentId: 'env-gh' })
    expect(getCloudWorkspaceSnapshot().status[PAIRED_ROW]?.status?.state).toBe('ready')
    expect(getCloudWorkspaceSnapshot().ids.has(PAIRED_ROW)).toBe(false)
    expect(cloudWorkspaceTarget('owned-row')).toEqual({ workspaceId: 'owned-row' })
  })

  it('drops the status of a row that is no longer paired', async () => {
    setPairedCloudWorkspaces({ [PAIRED_ROW]: 'env-gh' })
    await refreshCloudWorkspaceStatus(PAIRED_ROW)
    setPairedCloudWorkspaces({})
    expect(getCloudWorkspaceSnapshot().status[PAIRED_ROW]).toBeUndefined()
    expect(cloudWorkspaceTarget(PAIRED_ROW)).toEqual({ workspaceId: PAIRED_ROW })
  })
})
