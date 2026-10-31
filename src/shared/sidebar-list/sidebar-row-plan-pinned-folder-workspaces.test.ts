import { describe, expect, it } from 'vitest'
import { PINNED_GROUP_KEY, getProjectGroupHeaderKey } from './group-keys'
import { planSidebarRows } from './sidebar-row-plan'
import type { FolderWorkspace } from '../folder-workspace-types'
import type { ProjectGroup } from '../project-group-types'
import type { PinnedWorktreeDisplayPolicy, Row, WorktreeGroupBy } from './row-types'

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Design',
  parentPath: '/tmp/design-root',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: projectGroup.id,
    name: 'Design workspace',
    folderPath: '/tmp/design/workspace-1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

const pinnedFolder = makeFolderWorkspace({
  id: 'folder-pinned',
  name: 'Pinned folder',
  isPinned: true
})
const laneFolder = makeFolderWorkspace({ id: 'folder-lane', name: 'Lane folder' })

function planRows(args: {
  groupBy: WorktreeGroupBy
  folderWorkspaces: readonly FolderWorkspace[]
  pinnedDisplayPolicy?: PinnedWorktreeDisplayPolicy
}): Row[] {
  return planSidebarRows({
    groupBy: args.groupBy,
    worktrees: [],
    repoMap: new Map(),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: [],
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(),
    nestLineage: false,
    projectGroups: [projectGroup],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: args.folderWorkspaces,
    defaultHostId: 'local',
    pinnedDisplayPolicy: args.pinnedDisplayPolicy ?? 'single-location',
    filterRepoIds: []
  }).render(new Set())
}

function folderRowIdsUnderHeader(rows: readonly Row[], headerKey: string): string[] {
  const startIndex = rows.findIndex((row) => row.type === 'header' && row.key === headerKey)
  if (startIndex === -1) {
    return []
  }
  const ids: string[] = []
  for (let index = startIndex + 1; index < rows.length; index++) {
    const row = rows[index]
    if (row?.type === 'header') {
      break
    }
    if (row?.type === 'folder-workspace') {
      ids.push(row.folderWorkspace.id)
    }
  }
  return ids
}

function sectionKeyBefore(rows: readonly Row[], folderWorkspaceId: string): string | undefined {
  const index = rows.findIndex(
    (row) => row.type === 'folder-workspace' && row.folderWorkspace.id === folderWorkspaceId
  )
  if (index === -1) {
    return undefined
  }
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const row = rows[cursor]
    if (row?.type === 'header') {
      return row.key
    }
  }
  return undefined
}

function pinnedHeaderOf(rows: readonly Row[]) {
  return rows.find(
    (row): row is Extract<Row, { type: 'header' }> =>
      row.type === 'header' && row.key === PINNED_GROUP_KEY
  )
}

describe('planSidebarRows pinned folder workspaces', () => {
  it('moves a pinned folder workspace into the Pinned section and out of its project lane', () => {
    const rows = planRows({ groupBy: 'repo', folderWorkspaces: [pinnedFolder, laneFolder] })

    expect(pinnedHeaderOf(rows)?.count).toBe(1)
    expect(sectionKeyBefore(rows, 'folder-pinned')).toBe(PINNED_GROUP_KEY)
    expect(sectionKeyBefore(rows, 'folder-lane')).toBe(getProjectGroupHeaderKey(projectGroup.id))
    expect(rows.filter((row) => row.type === 'folder-workspace')).toHaveLength(2)
  })

  it('moves a pinned folder workspace out of the flat all-lane in none grouping', () => {
    const rows = planRows({ groupBy: 'none', folderWorkspaces: [pinnedFolder, laneFolder] })

    expect(sectionKeyBefore(rows, 'folder-pinned')).toBe(PINNED_GROUP_KEY)
    expect(sectionKeyBefore(rows, 'folder-lane')).toBe('all')
    const allHeader = rows.find(
      (row): row is Extract<Row, { type: 'header' }> => row.type === 'header' && row.key === 'all'
    )
    expect(allHeader?.count).toBe(1)
  })

  it('keeps a pinned folder workspace in its lane too under duplicate-in-groups', () => {
    const rows = planRows({
      groupBy: 'repo',
      folderWorkspaces: [pinnedFolder, laneFolder],
      pinnedDisplayPolicy: 'duplicate-in-groups'
    })

    const occurrences = rows.filter(
      (row) => row.type === 'folder-workspace' && row.folderWorkspace.id === 'folder-pinned'
    )
    expect(occurrences).toHaveLength(2)
    expect(sectionKeyBefore(rows, 'folder-pinned')).toBe(PINNED_GROUP_KEY)
    const laneOccurrences = folderRowIdsUnderHeader(rows, getProjectGroupHeaderKey(projectGroup.id))
    expect(laneOccurrences).toContain('folder-pinned')
    expect(laneOccurrences).toContain('folder-lane')
  })

  it('counts host-keyed folder-only pins in the Pinned header host stats', () => {
    const remoteFolder = makeFolderWorkspace({
      id: 'folder-remote',
      isPinned: true,
      executionHostId: 'ssh:gpu-vm'
    })
    const rows = planRows({ groupBy: 'repo', folderWorkspaces: [remoteFolder] })

    const pinnedHeader = pinnedHeaderOf(rows)
    expect(pinnedHeader?.count).toBe(1)
    expect(pinnedHeader?.hostWorktreeCounts?.get('ssh:gpu-vm')).toBe(1)
    expect(sectionKeyBefore(rows, 'folder-remote')).toBe(PINNED_GROUP_KEY)
  })

  it('gives duplicated pinned and lane folder rows distinct row keys', () => {
    const rows = planRows({
      groupBy: 'repo',
      folderWorkspaces: [pinnedFolder],
      pinnedDisplayPolicy: 'duplicate-in-groups'
    })

    const keys = rows
      .filter(
        (row) => row.type === 'folder-workspace' && row.folderWorkspace.id === 'folder-pinned'
      )
      .map((row) => (row.type === 'folder-workspace' ? row.key : ''))
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
  })
})
