import { describe, expect, it } from 'vitest'
import { normalizePairedServerRow } from './paired-server-rows'

const ROW = { worktreeId: 'repo::/srv/child', repoId: 'repo', path: '/srv/child', branch: 'child' }
const RECORD = {
  childWorkspaceKey: 'worktree:repo::/srv/child',
  childInstanceId: 'child-instance',
  parent: {
    installationId: 'mac-install',
    workspaceKey: 'worktree:mac-repo::/src/parent',
    instanceId: 'parent-instance'
  },
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 1
}

describe('normalizePairedServerRow cross-store parent', () => {
  it("keeps the server's cross-store record beside a null same-store lineage", () => {
    const row = normalizePairedServerRow('runtime:env-1', { ...ROW, crossStoreParent: RECORD })
    expect(row?.crossStoreParent).toEqual(RECORD)
    expect(row?.lineage).toBeNull()
  })

  it('lists a row with an unreadable record, standalone', () => {
    const row = normalizePairedServerRow('runtime:env-1', {
      ...ROW,
      crossStoreParent: { ...RECORD, parent: { installationId: 'mac-install' } }
    })
    expect(row?.worktreeId).toBe('repo::/srv/child')
    expect(row?.crossStoreParent).toBeUndefined()
  })
})
