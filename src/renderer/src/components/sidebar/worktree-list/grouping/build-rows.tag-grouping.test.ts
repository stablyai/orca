import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows'
import type { Row } from './row-types'
import { getGroupKeysForWorktree } from './worktree-group-keys'
import { getTagGroupKey, narrowTagRevealKeys, UNTAGGED_GROUP_KEY } from './tag-groups'
import { getRenderRowKey } from '../listing/render-row'
import { getRenderRowSidebarKey } from '../navigation/render-row-lookup'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

const otherRepo: Repo = { ...repo, id: 'repo-2', path: '/tmp/web', displayName: 'web' }
const repoMap = new Map([
  [repo.id, repo],
  [otherRepo.id, otherRepo]
])

const GROUP: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: '/tmp/platform',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

function makeWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return { ...worktree, id, path: `/tmp/${id}`, displayName: id, ...overrides }
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: GROUP.id,
    name: 'Ticket home',
    folderPath: '/tmp/platform',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function buildTagRows(options: {
  worktrees: Worktree[]
  folderWorkspaces?: FolderWorkspace[]
  collapsedGroups?: Set<string>
}): Row[] {
  return buildRows(
    'tag',
    options.worktrees,
    repoMap,
    null,
    options.collapsedGroups ?? new Set<string>(),
    undefined,
    undefined,
    'manual',
    {},
    new Map(options.worktrees.map((entry) => [entry.id, entry])),
    false,
    undefined,
    [GROUP],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    options.folderWorkspaces ?? []
  )
}

function headers(rows: Row[]): Extract<Row, { type: 'header' }>[] {
  return rows.filter((row): row is Extract<Row, { type: 'header' }> => row.type === 'header')
}

function sections(rows: Row[]): Record<string, string[]> {
  const bySection: Record<string, string[]> = {}
  let current = ''
  for (const row of rows) {
    if (row.type === 'header') {
      current = row.label
      bySection[current] = []
    } else if (row.type === 'item') {
      bySection[current].push(row.worktree.id)
    } else if (row.type === 'folder-workspace') {
      bySection[current].push(row.folderWorkspace.id)
    }
  }
  return bySection
}

describe('group by tag', () => {
  const api = makeWorktree('api-billing', { tags: ['Billing'] })
  const web = makeWorktree('web-billing', { repoId: otherRepo.id, tags: ['billing', 'UI'] })
  const loose = makeWorktree('loose')

  it('collects worktrees from different repos under one tag, and untagged last', () => {
    const rows = buildTagRows({ worktrees: [loose, web, api] })

    // "Billing" wins over "billing" whichever workspace is listed first.
    expect(headers(rows).map((row) => row.label)).toEqual(['Billing', 'UI', 'Untagged'])
    expect(sections(rows)).toEqual({
      Billing: ['web-billing', 'api-billing'],
      UI: ['web-billing'],
      Untagged: ['loose']
    })
  })

  it('renders a multi-tagged worktree once per tag with distinct row keys', () => {
    const rows = buildTagRows({ worktrees: [web] })
    const items = rows.filter((row) => row.type === 'item')

    expect(items).toHaveLength(2)
    expect(new Set(items.map((row) => row.rowKey)).size).toBe(2)
  })

  it('counts each section on its own and honors per-tag collapse', () => {
    const rows = buildTagRows({
      worktrees: [api, web, loose],
      collapsedGroups: new Set([getTagGroupKey('ui')])
    })

    expect(headers(rows).map((row) => [row.label, row.count])).toEqual([
      ['Billing', 2],
      ['UI', 1],
      ['Untagged', 1]
    ])
    expect(sections(rows).UI).toEqual([])
  })

  it('places folder workspaces under each of their tags without duplicate keys', () => {
    const folder = makeFolderWorkspace({ tags: ['Billing', 'Research'] })
    const rows = buildTagRows({ worktrees: [api], folderWorkspaces: [folder] })

    expect(sections(rows)).toEqual({ Billing: ['api-billing', 'fw-1'], Research: ['fw-1'] })
    const folderRows = rows.filter((row) => row.type === 'folder-workspace')
    expect(new Set(folderRows.map(getRenderRowKey)).size).toBe(2)
    expect(new Set(folderRows.map(getRenderRowSidebarKey)).size).toBe(2)
  })

  it('reveals a worktree by opening every section it renders in', () => {
    expect(getGroupKeysForWorktree('tag', web, repoMap, null)).toEqual([
      getTagGroupKey('billing'),
      getTagGroupKey('UI')
    ])
    expect(getGroupKeysForWorktree('tag', loose, repoMap, null)).toEqual([UNTAGGED_GROUP_KEY])
  })

  it('renders nothing extra when no workspace is tagged', () => {
    const rows = buildTagRows({ worktrees: [loose] })
    expect(headers(rows).map((row) => row.key)).toEqual([UNTAGGED_GROUP_KEY])
  })

  it('keeps the header spelling when sort order changes', () => {
    const first = buildTagRows({ worktrees: [web, api] })
    const second = buildTagRows({ worktrees: [api, web] })
    expect(headers(first)[0].label).toBe(headers(second)[0].label)
  })

  it('opens only one collapsed tag section when revealing, and none if one is open', () => {
    const keys = [getTagGroupKey('UI'), getTagGroupKey('billing'), 'host:local']
    expect(narrowTagRevealKeys(keys, new Set([keys[0], keys[1]]))).toEqual([
      'host:local',
      getTagGroupKey('billing')
    ])
    expect(narrowTagRevealKeys(keys, new Set([keys[0]]))).toEqual(['host:local'])
  })
})
