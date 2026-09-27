import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { RenderRow } from '../listing/render-row'
import { addHostSectionRows } from '../../host-section-rows'
import { getFolderWorkspaceHostId } from '../../folder-workspace-host-id'
import { buildSidebarGeometry } from '../listing/sidebar-geometry-slots'
import { getWorktreeOptionId } from '../rows/option-dom'
import { renderFolderWorkspaceVirtualRow, type FolderWorkspaceRowContext } from '../rows/folder-row'
import { getActiveDescendantOptionId, getRenderRowOptionId } from './active-descendant-option'
import {
  findPreferredRenderRowIndexForWorktreeIdentity,
  getRenderRowSidebarKey,
  renderRowContainsWorktree,
  rowKeyMatchesRenderRow
} from './render-row-lookup'
import {
  getFolderWorkspaceRevealGroupKeys,
  getKnownSidebarWorktreeById,
  sidebarWorkspaceStillExists
} from './folder-reveal'

vi.mock('../../WorktreeCard', () => ({ default: () => null }))

const workspaceKey = 'folder:same-folder'
const local: FolderWorkspace = {
  id: 'same-folder',
  projectGroupId: 'local-group',
  executionHostId: 'local',
  name: 'Local folder',
  folderPath: '/local',
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
const remote: FolderWorkspace = {
  ...local,
  projectGroupId: 'remote-group',
  executionHostId: 'ssh:box',
  connectionId: 'box',
  name: 'Remote folder',
  folderPath: '/remote'
}
const localGroup: ProjectGroup = {
  id: 'local-group',
  name: 'Local group',
  parentPath: '/local',
  parentGroupId: null,
  executionHostId: 'local',
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: true,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
const remoteGroup: ProjectGroup = {
  ...localGroup,
  id: 'remote-group',
  executionHostId: 'ssh:box',
  connectionId: 'box'
}
function row(
  folderWorkspace: FolderWorkspace,
  projectGroup: ProjectGroup
): Extract<RenderRow, { type: 'folder-workspace' }> {
  return {
    type: 'folder-workspace',
    key: `folder-workspace:${folderWorkspace.id}`,
    folderWorkspace,
    projectGroup,
    depth: 0,
    groupDepth: 0
  }
}
const rows = [row(local, localGroup), row(remote, remoteGroup)]

describe('same-ID folders on different hosts', () => {
  it.each([
    {
      folder: { ...local, executionHostId: undefined, connectionId: 'own' },
      group: { ...remoteGroup, executionHostId: undefined },
      expected: 'ssh:own'
    },
    { folder: { ...local, executionHostId: undefined }, group: remoteGroup, expected: 'ssh:box' },
    { folder: local, group: remoteGroup, expected: 'local' },
    {
      folder: { ...local, executionHostId: undefined, connectionId: 'nested' },
      group: { ...remoteGroup, executionHostId: 'runtime:server' as const },
      expected: 'runtime:server'
    }
  ])('shares rendered folder ownership for $expected', ({ folder, group, expected }) => {
    expect(getFolderWorkspaceHostId(folder, group, 'local')).toBe(expected)
    const inheritedRow = row(folder, group)
    expect(getRenderRowSidebarKey(inheritedRow)).toBe(`${expected}|${workspaceKey}`)
    expect(
      getKnownSidebarWorktreeById(
        workspaceKey,
        new Map(),
        [{ ...folder, projectGroupId: group.id }],
        [],
        undefined,
        { projectGroups: [group] }
      )?.hostId
    ).toBe(expected)
  })

  it('carries focused default host through composition without host headers', () => {
    const folder = { ...local, executionHostId: undefined }
    const group = { ...localGroup, executionHostId: undefined }
    const composed = addHostSectionRows({
      rows: [row(folder, group)],
      hostOptions: [],
      workspaceHostScope: 'all',
      defaultHostId: 'runtime:server',
      preferProjectGrouping: true
    })
    expect(getRenderRowSidebarKey(composed[0]!)).toBe(`runtime:server|${workspaceKey}`)
    expect(getRenderRowOptionId(composed[0])).toBe(
      getWorktreeOptionId(`runtime:server|${workspaceKey}`)
    )
  })

  it('routes explicit host requests and keeps omitted-host first-match behavior', () => {
    expect(
      findPreferredRenderRowIndexForWorktreeIdentity(
        rows,
        { id: workspaceKey, hostId: 'ssh:box' },
        'single-location'
      )
    ).toBe(1)
    expect(
      findPreferredRenderRowIndexForWorktreeIdentity(
        rows,
        { id: workspaceKey, hostId: undefined },
        'single-location'
      )
    ).toBe(0)
    expect(
      findPreferredRenderRowIndexForWorktreeIdentity(
        rows,
        { id: workspaceKey, hostId: 'ssh:missing' },
        'single-location'
      )
    ).toBe(-1)
    expect(renderRowContainsWorktree(rows[0]!, workspaceKey, 'ssh:box')).toBe(false)
    expect(renderRowContainsWorktree(rows[1]!, workspaceKey, 'ssh:box')).toBe(true)
  })

  it('resolves and checks existence on the requested execution host', () => {
    expect(
      getKnownSidebarWorktreeById(workspaceKey, new Map(), [local, remote], [], 'ssh:box')
    ).toMatchObject({ hostId: 'ssh:box', path: '/remote' })
    expect(getKnownSidebarWorktreeById(workspaceKey, new Map(), [local, remote])).toMatchObject({
      hostId: 'local'
    })
    expect(sidebarWorkspaceStillExists(workspaceKey, [], [local], 'ssh:box')).toBe(false)
    expect(sidebarWorkspaceStillExists(workspaceKey, [], [remote], 'ssh:box')).toBe(true)
  })

  it('expands only the requested folder group and host', () => {
    expect(
      getFolderWorkspaceRevealGroupKeys(workspaceKey, [local, remote], [localGroup, remoteGroup], {
        groupBy: 'repo',
        defaultHostId: 'local',
        executionHostId: 'ssh:box'
      })
    ).toEqual(['project-group:remote-group', 'host:ssh:box'])
  })

  it('uses distinct row and option identities, including aria navigation', () => {
    const remoteKey = `ssh:box|${workspaceKey}`
    expect(getRenderRowSidebarKey(rows[1]!)).toBe(remoteKey)
    expect(rowKeyMatchesRenderRow(rows[1]!, remoteKey)).toBe(true)
    expect(rowKeyMatchesRenderRow(rows[1]!, workspaceKey)).toBe(true)
    expect(getRenderRowOptionId(rows[0])).not.toBe(getRenderRowOptionId(rows[1]))
    expect(
      getActiveDescendantOptionId({
        activeWorktreeId: workspaceKey,
        activeWorkspaceExecutionHostId: 'ssh:box',
        pinnedDisplayPolicy: 'single-location',
        renderRows: rows,
        virtualItems: [{ index: 0 }, { index: 1 }]
      })
    ).toBe(getWorktreeOptionId(remoteKey))
  })

  it('keeps geometry observations distinct without host headers', () => {
    expect(new Set(buildSidebarGeometry(rows).nodes.map((node) => node.key)).size).toBe(2)
  })

  it('emits the same qualified option and activation keys that navigation resolves', () => {
    const ctx: FolderWorkspaceRowContext = {
      groupBy: 'repo',
      newCardStyle: false,
      settings: null,
      activeWorktreeId: null,
      currentWorktreeId: null,
      selectedWorktreeIds: new Set(),
      repoMap: new Map(),
      worktreeMap: new Map(),
      worktreeLineageById: {},
      workspaceLineageByChildKey: {},
      prCache: null,
      hostedReviewCache: null,
      getCachedFolderWorkspacePathStatus: () => null,
      onSelectionGesture: () => false,
      onContextMenuSelect: () => [],
      onImmediateActivate: vi.fn(),
      onRowClickCapture: vi.fn(),
      onRowPointerDown: vi.fn()
    }
    const element = renderFolderWorkspaceVirtualRow({
      ctx,
      row: rows[1]!,
      vItem: { index: 1, key: 'remote', start: 0, end: 50, size: 50, lane: 0 },
      measureVirtualRowElement: vi.fn()
    })
    expect(element.props.id).toBe(getWorktreeOptionId(`ssh:box|${workspaceKey}`))
    expect(element.props['data-worktree-row-key']).toBe(`ssh:box|${workspaceKey}`)
  })
})
