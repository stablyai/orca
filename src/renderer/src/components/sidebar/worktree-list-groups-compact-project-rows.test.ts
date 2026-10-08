import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import type { GroupHeaderRow, Row, WorktreeRow } from './worktree-list/grouping/row-types'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeAttention } from './smart-attention'
import { getDefaultSettings } from '../../../../shared/constants'

const repoA: Repo = { ...repo, id: 'repo-a', path: '/tmp/alpha', displayName: 'alpha' }
const repoB: Repo = { ...repo, id: 'repo-b', path: '/tmp/beta', displayName: 'beta' }
const repoC: Repo = { ...repo, id: 'repo-c', path: '/tmp/gamma', displayName: 'gamma' }
const repoMap = new Map([repoA, repoB, repoC].map((r) => [r.id, r]))
const repoOrder = new Map([
  [repoA.id, 0],
  [repoB.id, 1],
  [repoC.id, 2]
])

function wt(id: string, repoId: string, lastActivityAt = 0): Worktree {
  return { ...worktree, id, repoId, displayName: id, path: `/tmp/${id}`, lastActivityAt }
}

const COMPACT_SETTINGS: AppState['settings'] = {
  ...getDefaultSettings('/tmp'),
  compactProjectRows: true
}

function build(
  worktrees: Worktree[],
  options: {
    settings?: AppState['settings']
    projectOrderBy?: 'manual' | 'recent' | 'attention'
    attention?: Map<string, WorktreeAttention>
    pendingRepoId?: string
    activeWorktreeId?: string
    collapsedGroups?: Set<string>
  } = {}
): Row[] {
  return buildRows(
    'repo',
    worktrees,
    repoMap,
    null,
    options.collapsedGroups ?? new Set(),
    repoOrder,
    undefined,
    options.projectOrderBy ?? 'manual',
    {},
    undefined,
    false,
    options.settings,
    [],
    new Set(),
    new Map(),
    new Map(),
    options.pendingRepoId ? [{ creationId: 'c1', repoId: options.pendingRepoId }] : [],
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    options.attention,
    options.activeWorktreeId ?? null
  )
}

const headers = (rows: Row[]): GroupHeaderRow[] =>
  rows.filter((row): row is GroupHeaderRow => row.type === 'header')
const items = (rows: Row[]): WorktreeRow[] =>
  rows.filter((row): row is WorktreeRow => row.type === 'item')

describe('buildRows compact project rows', () => {
  const single = wt('wt-a', repoA.id)
  const multi = [wt('wt-b1', repoB.id), wt('wt-b2', repoB.id)]

  it('keeps a header above every project when the setting is off', () => {
    const rows = build([single, ...multi])
    expect(headers(rows).map((row) => row.key)).toEqual(['repo:repo-a', 'repo:repo-b'])
    expect(items(rows).every((row) => row.compactProjectHeader === undefined)).toBe(true)
    expect(headers(rows).every((row) => row.projectWorktreeIds === undefined)).toBe(true)
  })

  it('folds a single-workspace project into one row carrying its header', () => {
    const rows = build([single, ...multi], { settings: COMPACT_SETTINGS })
    expect(rows[0]).toMatchObject({
      type: 'item',
      worktree: { id: 'wt-a' },
      compactProjectHeader: { key: 'repo:repo-a', label: 'alpha', repo: { id: 'repo-a' } }
    })
    expect(headers(rows).map((row) => row.key)).toEqual(['repo:repo-b'])
  })

  it('collapses a multi-workspace project to its header when another project is active', () => {
    const rows = build([single, ...multi], { settings: COMPACT_SETTINGS, activeWorktreeId: 'wt-a' })
    const header = headers(rows).find((row) => row.key === 'repo:repo-b')
    expect(header).toMatchObject({
      compactProjectActive: false,
      projectWorktreeIds: ['wt-b1', 'wt-b2']
    })
    expect(items(rows).map((row) => row.worktree.id)).toEqual(['wt-a'])
    expect(rows[0]).toMatchObject({ compactProjectHeader: { compactProjectActive: true } })
  })

  it('expands only the project holding the active workspace', () => {
    const rows = build([single, ...multi], {
      settings: COMPACT_SETTINGS,
      activeWorktreeId: 'wt-b2'
    })
    expect(headers(rows).find((row) => row.key === 'repo:repo-b')?.compactProjectActive).toBe(true)
    expect(items(rows).map((row) => row.worktree.id)).toEqual(['wt-a', 'wt-b1', 'wt-b2'])
    // Why: expanded cards force their agent rows, whatever the card display properties say.
    expect(items(rows).map((row) => row.inExpandedCompactProject === true)).toEqual([
      false,
      true,
      true
    ])
    expect(rows[0]).toMatchObject({ compactProjectHeader: { compactProjectActive: false } })
  })

  it('folds the expanded project when its chevron collapsed it', () => {
    const rows = build(multi, {
      settings: COMPACT_SETTINGS,
      activeWorktreeId: 'wt-b1',
      collapsedGroups: new Set(['repo:repo-b'])
    })
    expect(rows.map((row) => row.type)).toEqual(['header'])
  })

  it('lists a project notice only inside the expanded section', () => {
    const notice = new Map([[repoA.id, { repo: repoA, hiddenWorktrees: [] }]])
    const buildWithNotice = (activeWorktreeId: string | null): Row[] =>
      buildRows(
        'repo',
        [single, ...multi],
        repoMap,
        null,
        new Set(),
        repoOrder,
        undefined,
        'manual',
        {},
        undefined,
        false,
        COMPACT_SETTINGS,
        [],
        new Set(),
        notice,
        new Map(),
        [],
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        activeWorktreeId
      )
    const noticeRows = (rows: Row[]): Row[] =>
      rows.filter((row) => row.type === 'imported-worktrees-card')
    expect(noticeRows(buildWithNotice('wt-b1'))).toHaveLength(0)
    const expanded = buildWithNotice('wt-a')
    expect(expanded[0]?.type).toBe('item')
    expect(expanded[1]?.type).toBe('imported-worktrees-card')
  })

  it('still folds a collapsed single-workspace project, since the row is the project', () => {
    const rows = buildRows(
      'repo',
      [single],
      repoMap,
      null,
      new Set(['repo:repo-a']),
      repoOrder,
      undefined,
      'manual',
      {},
      undefined,
      false,
      COMPACT_SETTINGS
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'item', compactProjectHeader: { key: 'repo:repo-a' } })
  })

  it('keeps the header while a workspace is being created in that project', () => {
    const rows = build([single], { settings: COMPACT_SETTINGS, pendingRepoId: repoA.id })
    expect(headers(rows).map((row) => row.key)).toEqual(['repo:repo-a'])
    expect(rows.some((row) => row.type === 'pending-creation')).toBe(true)
  })
})

describe('buildRows attention project order', () => {
  const wA = wt('wt-a', repoA.id, 100)
  const wB = wt('wt-b', repoB.id, 300)
  const wC1 = wt('wt-c1', repoC.id, 200)
  const wC2 = wt('wt-c2', repoC.id, 50)

  it('ranks projects by their most urgent workspace class', () => {
    const attention = new Map<string, WorktreeAttention>([
      ['wt-a', { cls: 3, attentionTimestamp: 10 }],
      ['wt-b', { cls: 2, attentionTimestamp: 10 }],
      // Why: a project ranks by its most urgent workspace, not its first one.
      ['wt-c2', { cls: 1, attentionTimestamp: 5, cause: 'waiting' }]
    ])
    const rows = build([wA, wB, wC1, wC2], { projectOrderBy: 'attention', attention })
    expect(headers(rows).map((row) => row.key)).toEqual([
      'repo:repo-c',
      'repo:repo-b',
      'repo:repo-a'
    ])
  })

  it('breaks class ties by the most recent attention event', () => {
    const attention = new Map<string, WorktreeAttention>([
      ['wt-a', { cls: 2, attentionTimestamp: 900 }],
      ['wt-b', { cls: 2, attentionTimestamp: 100 }]
    ])
    const rows = build([wA, wB], { projectOrderBy: 'attention', attention })
    expect(headers(rows).map((row) => row.key)).toEqual(['repo:repo-a', 'repo:repo-b'])
  })

  it('orders idle projects by recent activity', () => {
    const rows = build([wA, wB, wC1, wC2], { projectOrderBy: 'attention', attention: new Map() })
    expect(headers(rows).map((row) => row.key)).toEqual([
      'repo:repo-b',
      'repo:repo-c',
      'repo:repo-a'
    ])
  })

  it('orders compact single-workspace rows by attention too', () => {
    const attention = new Map<string, WorktreeAttention>([
      ['wt-b', { cls: 1, attentionTimestamp: 1, cause: 'blocked' }]
    ])
    const rows = build([wA, wB], {
      projectOrderBy: 'attention',
      attention,
      settings: COMPACT_SETTINGS
    })
    expect(items(rows).map((row) => row.compactProjectHeader?.key)).toEqual([
      'repo:repo-b',
      'repo:repo-a'
    ])
  })
})

describe('buildRows attention order details', () => {
  it('keeps the persisted Smart snapshot until live agent evidence arrives', () => {
    const rows = build(
      [
        { ...wt('wt-a', repoA.id, 900), sortOrder: 1 },
        { ...wt('wt-b', repoB.id, 100), sortOrder: 5 }
      ],
      { projectOrderBy: 'attention' }
    )
    expect(headers(rows).map((row) => row.key)).toEqual(['repo:repo-b', 'repo:repo-a'])
  })

  it('ranks projects by attention inside a Project Group', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Clients',
      parentPath: '/clients',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const grouped = [repoA, repoB].map((r) => ({ ...r, projectGroupId: group.id }))
    const rows = buildRows(
      'repo',
      [wt('wt-a', repoA.id), wt('wt-b', repoB.id)],
      new Map(grouped.map((r) => [r.id, r])),
      null,
      new Set(),
      repoOrder,
      undefined,
      'attention',
      {},
      undefined,
      false,
      undefined,
      [group],
      new Set(),
      new Map(),
      new Map(),
      [],
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      new Map<string, WorktreeAttention>([
        ['wt-b', { cls: 1, attentionTimestamp: 1, cause: 'waiting' }]
      ])
    )
    expect(headers(rows).map((row) => row.key)).toEqual([
      'project-group:group-1',
      'repo:repo-b',
      'repo:repo-a'
    ])
  })
})
