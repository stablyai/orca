import { describe, expect, it } from 'vitest'
import { makeRepo, makeWorktree } from './worktree-list-lineage-card-test-fixtures'
import { buildRows } from './worktree-list/grouping/build-rows'
import { addHostSectionRows } from './host-section-rows'
import { scopePinnedSectionCollapse } from './host-pinned-sections'

for (const hostId of ['ssh:builder', 'runtime:builder'] as const) {
  describe(`pinned sections on ${hostId}`, () => {
    const localRepo = makeRepo()
    const remoteRepo = { ...localRepo, id: 'remote-repo', executionHostId: hostId }
    const repoMap = new Map([
      [localRepo.id, localRepo],
      [remoteRepo.id, remoteRepo]
    ])
    const local = {
      ...makeWorktree({
        id: 'local',
        instanceId: 'local',
        displayName: 'Local pin',
        branch: 'local',
        sortOrder: 0
      }),
      hostId: 'local' as const,
      isPinned: true
    }
    const remote = { ...local, id: 'remote', repoId: remoteRepo.id, hostId }
    const rows = buildRows('none', [local, remote], repoMap, null, new Set())
    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        { id: 'local', kind: 'local', label: 'Local', detail: '', health: 'local' },
        {
          id: hostId,
          kind: hostId.startsWith('ssh:') ? 'ssh' : 'runtime',
          label: 'Remote',
          detail: '',
          health: 'available'
        }
      ],
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: ['local', hostId],
      defaultHostId: 'local'
    })

    it('keeps remote pins visible while local pins are collapsed', () => {
      const result = scopePinnedSectionCollapse({
        rows: sectioned,
        collapsedGroups: new Set(['pinned']),
        defaultHostId: 'local'
      })
      expect(result.filter((row) => row.type === 'item').map((row) => row.worktree.id)).toEqual([
        'remote'
      ])
      expect(result.filter((row) => row.type === 'header').map((row) => row.collapseKey)).toEqual([
        'pinned',
        `pinned:host:${hostId}`
      ])
    })

    it('keeps local pins visible while remote pins are collapsed', () => {
      const result = scopePinnedSectionCollapse({
        rows: sectioned,
        collapsedGroups: new Set([`pinned:host:${hostId}`]),
        defaultHostId: 'local'
      })
      expect(result.filter((row) => row.type === 'item').map((row) => row.worktree.id)).toEqual([
        'local'
      ])
    })

    it('retains remote collapse ownership when it is the only visible host', () => {
      const remoteRows = buildRows('none', [remote], repoMap, null, new Set())
      const result = scopePinnedSectionCollapse({
        rows: remoteRows,
        collapsedGroups: new Set([`pinned:host:${hostId}`]),
        defaultHostId: 'local'
      })
      expect(result.filter((row) => row.type === 'item')).toEqual([])
      expect(result.filter((row) => row.type === 'header').map((row) => row.collapseKey)).toEqual([
        `pinned:host:${hostId}`
      ])
    })
  })
}
