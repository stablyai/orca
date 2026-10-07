import { describe, expect, it } from 'vitest'
import { sortProjectEntries } from './section-order'
import { appendProjectGroupSections } from './project-group-sections'
import type { SectionAppendContext } from './group-sections'
import { PROJECT_GROUP_META } from './group-keys'
import type { OrderedGroupEntry } from './project-grouping'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'

function entry(
  key: string,
  label: string,
  activities: number[],
  addedAt = 0,
  repoIds = [key]
): OrderedGroupEntry {
  return [
    key,
    {
      label,
      repo: { ...repo, id: key, addedAt },
      repoIds: new Set(repoIds),
      items: activities.map((lastActivityAt, index) => ({
        ...worktree,
        id: `${key}:${index}`,
        lastActivityAt
      }))
    }
  ]
}

function countedEntries(): { entries: OrderedGroupEntry[]; readCount: () => number } {
  let reads = 0
  const entries: OrderedGroupEntry[] = Array.from({ length: 128 }, (_, group) => [
    String(group),
    {
      label: String(group),
      repoIds: new Set([String(group)]),
      items: Array.from({ length: 32 }, (_, index) => ({
        ...worktree,
        id: `${group}:${index}`,
        get lastActivityAt() {
          reads += 1
          return (group * 73) % 128
        }
      }))
    }
  ])
  return { entries, readCount: () => reads }
}

describe('recent project rank scan budget', () => {
  it('scans each project workspace list once per recent sort and preserves the complete order', () => {
    const { entries, readCount } = countedEntries()
    const sorted = sortProjectEntries(entries, 'recent', undefined)
    const expected = entries.toSorted(
      (left, right) => ((Number(right[0]) * 73) % 128) - ((Number(left[0]) * 73) % 128)
    )
    expect(sorted).toEqual(expected)
    sorted.forEach((row, index) => expect(row).toBe(expected[index]))
    expect(readCount()).toBe(128 * 33)
  })

  it('reuses workspace ranks within a project group while preserving every header', () => {
    const { entries, readCount } = countedEntries()
    const grouped: OrderedGroupEntry[] = entries.map(([key, group]) => [
      key,
      { ...group, repo: { ...repo, id: key, path: `/${key}`, projectGroupId: 'parent' } }
    ])
    const ctx: SectionAppendContext = {
      result: [],
      groupBy: 'repo',
      collapsedGroups: new Set(grouped.map(([key]) => key)),
      workspaceStatuses: [],
      repoMap: new Map(),
      defaultHostId: 'local',
      hostLabelById: undefined,
      projectIndex: null,
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingByRepo: new Map(),
      mixedWorktreeHostContextLabels: undefined,
      noticeHostContextLabelByRepoId: undefined,
      lineageById: {},
      worktreeMap: new Map(),
      nestLineage: false,
      cyclicLineageIds: new Set(),
      attachedByFolderId: new Map()
    }
    appendProjectGroupSections(ctx, {
      orderedGroups: grouped,
      projectGroups: [
        {
          id: 'parent',
          name: 'parent',
          parentPath: null,
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 0,
          updatedAt: 0
        }
      ],
      folderWorkspaces: [],
      projectOrderBy: 'recent',
      repoOrder: undefined
    })
    const expected = grouped.toSorted(
      (left, right) => ((Number(right[0]) * 73) % 128) - ((Number(left[0]) * 73) % 128)
    )
    expect(ctx.result).toHaveLength(129)
    expect(ctx.result[0]).toMatchObject({ type: 'header', count: 128, projectGroupDepth: 0 })
    expect(ctx.result.slice(1)).toEqual(
      expected.map(([key, group]) => ({
        type: 'header',
        key,
        label: group.label,
        count: 32,
        tone: PROJECT_GROUP_META.tone,
        icon: PROJECT_GROUP_META.icon,
        repo: group.repo,
        projectGroupDepth: 1
      }))
    )
    expect(readCount()).toBe(128 * 33)
  })

  it('preserves identity collisions, manual ties, stable ties and missing activity fallbacks', () => {
    const hottest = entry('collision', 'hottest', [10, 300, 20])
    const hot = entry('collision', 'hot', [200])
    const tieA = entry('a', 'same', [100], 0, ['tie'])
    const tieB = entry('b', 'same', [100], 0, ['tie'])
    const tieRank = entry('rank', 'later label', [100], 0, ['rank'])
    const emptyNew = entry('new', 'new', [], 999)
    const emptyOld = entry('old', 'old', [], 1)
    const noRepo: OrderedGroupEntry = [
      'no-repo',
      { label: 'absent', items: [], repoIds: new Set() }
    ]
    const missing = entry('missing', 'missing', [0], 5)
    Reflect.deleteProperty(missing[1].items[0], 'lastActivityAt')
    const invalid = entry('invalid', 'invalid', [Number.NaN, Number.NEGATIVE_INFINITY], 6)
    const infinite = entry('infinite', 'infinite', [Number.POSITIVE_INFINITY])
    const entries = [
      tieA,
      hot,
      emptyOld,
      hottest,
      noRepo,
      invalid,
      tieB,
      missing,
      emptyNew,
      tieRank,
      infinite,
      tieA
    ]
    const order = new Map([
      ['rank', 0],
      ['tie', 1]
    ])
    const expected = [
      infinite,
      hottest,
      hot,
      tieRank,
      tieA,
      tieB,
      tieA,
      emptyNew,
      invalid,
      missing,
      emptyOld,
      noRepo
    ]
    const actual = sortProjectEntries(entries, 'recent', order)
    expect(actual).toEqual(expected)
    actual.forEach((row, index) => expect(row).toBe(expected[index]))
    expect(entries[0]).toBe(tieA)
  })

  it('reads current activity and fallback evidence on each new call and leaves manual mode intact', () => {
    const first = entry('first', 'first', [100])
    const second = entry('second', 'second', [200])
    const old = entry('old', 'old', [], 1)
    const newer = entry('newer', 'newer', [], 2)
    const entries = [first, second, old, newer]
    expect(sortProjectEntries(entries, 'recent', undefined)).toEqual([second, first, newer, old])
    first[1].items[0].lastActivityAt = 300
    if (!old[1].repo) {
      throw new Error('Missing fixture repository')
    }
    old[1].repo.addedAt = 3
    expect(sortProjectEntries(entries, 'recent', undefined)).toEqual([first, second, old, newer])
    expect(sortProjectEntries(entries, 'manual', undefined)).toBe(entries)
    expect(
      sortProjectEntries(entries, 'manual', new Map(entries.map(([key], index) => [key, -index])))
    ).toEqual([newer, old, second, first])
  })

  it('copies empty and single-project inputs without scanning their workspace activity', () => {
    const { entries, readCount } = countedEntries()
    expect(sortProjectEntries([], 'recent', undefined)).toEqual([])
    const single = entries.slice(0, 1)
    const sorted = sortProjectEntries(single, 'recent', undefined)
    expect(sorted).toEqual(single)
    expect(sorted).not.toBe(single)
    expect(sorted[0]).toBe(single[0])
    expect(readCount()).toBe(0)
  })
})
