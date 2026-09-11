import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { addHostSectionRows, type HostSectionRow } from './host-section-rows'
import type { Row } from './worktree-list/grouping/row-types'
import {
  estimateRenderRowSize,
  HOST_STICKY_PINNED_HEIGHT
} from './worktree-list/viewport/virtual-rows'
import { getRenderRowKey, type RenderRow } from './worktree-list/listing/render-row'

function repo(id: string, connectionId?: string | null): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId
  }
}

function worktree(id: string, repoId: string): Worktree {
  return {
    id,
    repoId,
    path: `/${repoId}/${id}`,
    branch: `refs/heads/${id}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    comment: '',
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    displayName: id
  }
}

function projectGroupHeader(groupId: string, label: string): Extract<Row, { type: 'header' }> {
  return {
    type: 'header',
    key: `project-group:${groupId}`,
    label,
    count: 1,
    tone: 'text-foreground',
    projectGroup: {
      id: groupId,
      name: label,
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    },
    projectGroupDepth: 0
  }
}

function item(wt: Worktree, r: Repo): Extract<Row, { type: 'item' }> {
  return {
    type: 'item',
    key: wt.id,
    rowKey: `all:${wt.id}`,
    sectionKey: 'all',
    worktree: wt,
    repo: r,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: true,
    lineageChildCount: 0
  } as Extract<Row, { type: 'item' }>
}

const localAi = repo('local-ai')
const localOther = repo('local-other')
const homeAi = repo('home-ai', 'home')
const mac3Ai = repo('mac3-ai', 'mac3')
const mac3Other = repo('mac3-other', 'mac3')

const hostOptions = [
  {
    id: 'local' as const,
    kind: 'local' as const,
    label: 'Local Mac',
    detail: 'This computer',
    health: 'local' as const
  },
  {
    id: 'ssh:home' as const,
    kind: 'ssh' as const,
    label: 'Home',
    detail: 'Orca server',
    health: 'available' as const
  },
  {
    id: 'ssh:mac3' as const,
    kind: 'ssh' as const,
    label: 'mac3',
    detail: 'Orca server',
    health: 'available' as const
  }
]

// Multi-host Projects filter: same project-group headers appear under each host.
const baseRows: Row[] = [
  projectGroupHeader('ai', 'ai'),
  item(worktree('wt-local-ai', 'local-ai'), localAi),
  item(worktree('wt-home-ai', 'home-ai'), homeAi),
  item(worktree('wt-mac3-ai', 'mac3-ai'), mac3Ai),
  projectGroupHeader('other', 'other'),
  item(worktree('wt-local-other', 'local-other'), localOther),
  item(worktree('wt-mac3-other', 'mac3-other'), mac3Other)
]

function section(collapsedHostKeys?: ReadonlySet<string>): HostSectionRow[] {
  return addHostSectionRows({
    rows: baseRows,
    hostOptions,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: ['local', 'ssh:home', 'ssh:mac3'],
    defaultHostId: 'local',
    collapsedHostKeys,
    preferProjectGrouping: true
  })
}

function assertUniqueRenderKeys(rows: readonly HostSectionRow[]): void {
  const keys = rows.map((row) => getRenderRowKey(row))
  expect(new Set(keys).size).toBe(keys.length)
}

describe('host collapse multi-host style uniqueness (#12300)', () => {
  it('stamps hostId so project-group headers stay unique across host sections', () => {
    const expanded = section()
    assertUniqueRenderKeys(expanded)

    const projectHeaders = expanded.filter(
      (row): row is Extract<HostSectionRow, { type: 'header' }> =>
        row.type === 'header' && row.key.startsWith('project-group:')
    )
    expect(projectHeaders.length).toBeGreaterThanOrEqual(2)
    expect(projectHeaders.every((row) => row.hostId != null)).toBe(true)
    expect(projectHeaders.map((row) => getRenderRowKey(row))).toEqual(
      expect.arrayContaining([
        'hdr:local:project-group:ai',
        'hdr:ssh:home:project-group:ai',
        'hdr:ssh:mac3:project-group:ai',
        'hdr:local:project-group:other',
        'hdr:ssh:mac3:project-group:other'
      ])
    )
  })

  it('keeps unique keys after collapsing and re-expanding a host section', () => {
    const collapsedHome = section(new Set(['host:ssh:home']))
    assertUniqueRenderKeys(collapsedHome)
    expect(
      collapsedHome.find((row) => row.type === 'host-header' && row.hostId === 'ssh:home')
    ).toMatchObject({ collapsed: true, count: 1 })
    // Collapsed host omits its project rows but keeps the host card.
    expect(
      collapsedHome.some(
        (row) =>
          row.type === 'header' && row.key === 'project-group:ai' && row.hostId === 'ssh:home'
      )
    ).toBe(false)

    const reexpanded = section()
    assertUniqueRenderKeys(reexpanded)
    expect(
      reexpanded.some(
        (row) =>
          row.type === 'header' && row.key === 'project-group:ai' && row.hostId === 'ssh:home'
      )
    ).toBe(true)
  })

  it('reuses an already-localized header for its owning host', () => {
    const localHeader = { ...projectGroupHeader('ai', 'ai'), hostId: 'local' as const }
    const localized = addHostSectionRows({
      rows: [
        localHeader,
        item(worktree('wt-local-ai', 'local-ai'), localAi),
        item(worktree('wt-home-ai', 'home-ai'), homeAi)
      ],
      hostOptions,
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: ['local', 'ssh:home'],
      defaultHostId: 'local',
      preferProjectGrouping: true
    })

    expect(
      localized.find(
        (row) => row.type === 'header' && row.key === 'project-group:ai' && row.hostId === 'local'
      )
    ).toBe(localHeader)
  })

  it('sizes host headers with inner padding so sticky geometry matches paint', () => {
    const rows = section() as RenderRow[]
    const firstHost = rows.findIndex((row) => row.type === 'host-header')
    const secondHost = rows.findIndex(
      (row, index) => index > firstHost && row.type === 'host-header'
    )
    expect(estimateRenderRowSize(rows, firstHost, firstHost, null)).toBe(HOST_STICKY_PINNED_HEIGHT)
    // Secondary host keeps the inter-group top margin on top of the inner pt-1.
    expect(estimateRenderRowSize(rows, secondHost, firstHost, null)).toBe(
      HOST_STICKY_PINNED_HEIGHT + 4
    )
  })

  it('does not section when a single host is filtered (control)', () => {
    const localOnly = addHostSectionRows({
      rows: baseRows.filter(
        (row) =>
          row.type === 'header' ||
          (row.type === 'item' && row.repo != null && !row.repo.connectionId)
      ),
      hostOptions,
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: ['local'],
      defaultHostId: 'local',
      preferProjectGrouping: true
    })
    expect(localOnly.some((row) => row.type === 'host-header')).toBe(false)
    assertUniqueRenderKeys(localOnly)
  })
})
