import { describe, expect, it } from 'vitest'
import { makeRepo, makeWorktree } from './worktree-list-lineage-card-test-fixtures'
import { buildRows } from './worktree-list/grouping/build-rows'
import { addHostSectionRows } from './host-section-rows'
import { scopeHostSectionCollapse, deferHostSectionCollapse } from './host-section-collapse'

for (const [groupBy, sectionKey, pinned] of [
  ['none', 'pinned', true],
  ['none', 'all', false],
  ['workspace-status', 'workspace-status:in-progress', false],
  ['pr-status', 'pr:in-progress', false]
] as const) {
  for (const hostId of ['ssh:builder', 'runtime:builder'] as const) {
    describe(`${sectionKey} sections on ${hostId}`, () => {
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
        isPinned: pinned
      }
      const remote = { ...local, id: 'remote', repoId: remoteRepo.id, hostId }
      const rows = buildRows(groupBy, [local, remote], repoMap, null, new Set())
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
        const result = scopeHostSectionCollapse({
          rows: sectioned,
          collapsedGroups: new Set([sectionKey])
        })
        expect(result.filter((row) => row.type === 'item').map((row) => row.worktree.id)).toEqual([
          'remote'
        ])
        expect(result.filter((row) => row.type === 'header').map((row) => row.collapseKey)).toEqual(
          [sectionKey, `${sectionKey}:host:${hostId}`]
        )
      })

      it('keeps local pins visible while remote pins are collapsed', () => {
        const result = scopeHostSectionCollapse({
          rows: sectioned,
          collapsedGroups: new Set([`${sectionKey}:host:${hostId}`])
        })
        expect(result.filter((row) => row.type === 'item').map((row) => row.worktree.id)).toEqual([
          'local'
        ])
      })

      it('retains remote collapse ownership when it is the only visible host', () => {
        const remoteRows = buildRows(groupBy, [remote], repoMap, null, new Set())
        const result = scopeHostSectionCollapse({
          rows: remoteRows,
          collapsedGroups: new Set([`${sectionKey}:host:${hostId}`])
        })
        expect(result.filter((row) => row.type === 'item')).toEqual([])
        expect(result.filter((row) => row.type === 'header').map((row) => row.collapseKey)).toEqual(
          [`${sectionKey}:host:${hostId}`]
        )
      })
    })
  }
}

it('defers only lane collapse and retains unrelated project/lineage collapse', () => {
  const groups = new Set([
    'pinned',
    'all',
    'pr:in-progress',
    'workspace-status:done',
    'repo:1',
    'lineage:local|parent'
  ])
  expect([...deferHostSectionCollapse(groups)]).toEqual(['repo:1', 'lineage:local|parent'])
  expect(groups.size).toBe(6)
  const unchanged = new Set(['repo:1'])
  expect(deferHostSectionCollapse(unchanged)).toBe(unchanged)
})
