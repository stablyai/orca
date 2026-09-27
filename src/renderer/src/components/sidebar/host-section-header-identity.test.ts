import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Row } from './worktree-list/grouping/row-types'
import { addHostSectionRows, type HostSectionOption } from './host-section-rows'
import { getRenderRowKey } from './worktree-list/listing/render-row'
import { repo, remoteRepo, worktree } from './worktree-list-groups-test-fixtures'

const hosts: HostSectionOption[] = [
  { id: 'local', kind: 'local', label: 'Local', detail: '', health: 'local' },
  { id: 'ssh:gpu-vm', kind: 'ssh', label: 'Remote', detail: '', health: 'available' }
]
const group: ProjectGroup = {
  id: 'group',
  name: 'Group',
  parentPath: '/group',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
function header(depth = 0): Extract<Row, { type: 'header' }> {
  return {
    type: 'header',
    key: 'project-group:group',
    label: 'Group',
    count: 1,
    tone: 'text-foreground',
    projectGroup: group,
    projectGroupDepth: depth
  }
}
function item(project: typeof repo): Extract<Row, { type: 'item' }> {
  return {
    type: 'item',
    rowKey: project.id,
    sectionKey: project.id,
    worktree: { ...worktree, id: project.id, repoId: project.id },
    repo: project,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: true,
    lineageChildCount: 0
  }
}
function compose(rows: Row[]) {
  return addHostSectionRows({
    rows,
    hostOptions: hosts,
    workspaceHostScope: 'all',
    defaultHostId: 'local'
  })
}

describe('host-local header occurrences', () => {
  it.each(['empty-hosts', 'project-first', 'single-host'] as const)(
    'distinguishes collapsed same-ID project owners through the %s path',
    (path) => {
      const local = { ...header(), projectGroup: { ...group, executionHostId: 'local' as const } }
      const remote = {
        ...header(),
        projectGroup: { ...group, executionHostId: 'ssh:gpu-vm' as const }
      }
      const rows = addHostSectionRows({
        rows: [local, remote],
        hostOptions: path === 'single-host' ? hosts.slice(0, 1) : hosts,
        workspaceHostScope: 'all',
        defaultHostId: 'local',
        preferProjectGrouping: path === 'project-first'
      })
      expect(rows.map(getRenderRowKey)).toEqual([
        'hdr:local:project-group:group',
        'hdr:ssh:gpu-vm:project-group:group'
      ])
      expect(rows.map((row) => (row.type === 'header' ? row.key : null))).toEqual([
        'project-group:group',
        'project-group:group'
      ])
    }
  )

  it('resolves an unpinned project owner from focused host before unsplit rendering', () => {
    const rows = addHostSectionRows({
      rows: [header()],
      hostOptions: hosts,
      workspaceHostScope: 'all',
      defaultHostId: 'runtime:focused',
      preferProjectGrouping: true
    })
    expect(rows.map(getRenderRowKey)).toEqual(['hdr:runtime:focused:project-group:group'])
  })

  it('qualifies a generic header copied to both hosts without hiding either copy', () => {
    const generic = { ...header(), key: 'all', projectGroup: undefined }
    const rows = compose([generic, item(repo), item(remoteRepo)])
    const headers = rows.filter((row) => row.type === 'header')
    expect(headers.map(getRenderRowKey)).toEqual(['hdr:local:all', 'hdr:ssh:gpu-vm:all'])
    expect(rows.filter((row) => row.type === 'item')).toHaveLength(2)
  })

  it.each([0, 1])(
    'ends a project group at an unrelated repo boundary (group depth %s)',
    (depth) => {
      const folder: Extract<Row, { type: 'folder-workspace' }> = {
        type: 'folder-workspace',
        key: 'folder',
        projectGroup: group,
        depth: 0,
        groupDepth: depth + 1,
        folderWorkspace: {
          id: 'folder',
          projectGroupId: group.id,
          executionHostId: 'ssh:gpu-vm',
          name: 'Folder',
          folderPath: '/group',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      }
      const rows = compose([
        header(depth),
        folder,
        { ...header(), key: 'repo:local', projectGroup: undefined, repo, projectGroupDepth: 0 },
        item(repo)
      ])
      expect(
        rows
          .filter((row) => row.type === 'header' && row.projectGroup?.id === group.id)
          .map(getRenderRowKey)
      ).toEqual(['hdr:ssh:gpu-vm:project-group:group'])
      expect(new Set(rows.map(getRenderRowKey)).size).toBe(rows.length)
    }
  )

  it('keeps a project group with its nested repo on each execution host', () => {
    const rows = compose([
      header(),
      {
        ...header(),
        key: 'repo:local',
        projectGroup: undefined,
        repo: { ...repo, projectGroupId: group.id },
        projectGroupDepth: 1
      },
      item(repo),
      {
        ...header(),
        key: 'repo:remote',
        projectGroup: undefined,
        repo: { ...remoteRepo, projectGroupId: group.id },
        projectGroupDepth: 1
      },
      item(remoteRepo)
    ])
    expect(
      rows
        .filter((row) => row.type === 'header' && row.projectGroup?.id === group.id)
        .map(getRenderRowKey)
    ).toEqual(['hdr:local:project-group:group', 'hdr:ssh:gpu-vm:project-group:group'])
  })

  it('preserves an unused collapsed group when the next repo is unrelated', () => {
    const rows = compose([
      header(),
      { ...header(), key: 'repo:local', projectGroup: undefined, repo, projectGroupDepth: 0 },
      item(repo),
      item(remoteRepo)
    ])
    expect(
      rows.filter((row) => row.type === 'header' && row.projectGroup?.id === group.id)
    ).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'header', key: header().key })
  })
})
