import { describe, expect, it } from 'vitest'
import {
  NEEDS_ATTENTION_GROUP_KEY,
  PINNED_GROUP_KEY
} from '../../../../../../shared/sidebar-list/group-keys'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import { worktree, repoMap } from '../../worktree-list-groups-test-fixtures'
import { createSidebarPRGroupReader } from './pr-group-key'

function planWithNeedsAttention(
  groupBy: 'none' | 'repo',
  worktrees: Worktree[],
  needsAttentionWorktreeIds: ReadonlySet<string>,
  lineageById: Record<string, WorktreeLineage> = {}
) {
  return planSidebarRows({
    groupBy,
    worktrees,
    repoMap,
    prGroupOf: createSidebarPRGroupReader(repoMap, null),
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById,
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    nestLineage: true,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: [],
    needsAttentionWorktreeIds
  })
}

function buildRowsWithNeedsAttention(
  groupBy: 'none' | 'repo',
  worktrees: Worktree[],
  needsAttentionWorktreeIds: ReadonlySet<string>,
  collapsedGroups = new Set<string>()
): Row[] {
  return planWithNeedsAttention(groupBy, worktrees, needsAttentionWorktreeIds).render(
    collapsedGroups
  )
}

function itemKeys(rows: Row[]): string[] {
  return rows.flatMap((row) =>
    row.type === 'item' ? [`${row.sectionKey}/${row.worktree.id}`] : []
  )
}

describe('planSidebarRows with a Needs you section', () => {
  const alpha = { ...worktree, id: 'wt-alpha', displayName: 'alpha' }
  const blocked = { ...worktree, id: 'wt-blocked', displayName: 'blocked' }
  const pinnedBlocked = {
    ...worktree,
    id: 'wt-pinned-blocked',
    displayName: 'pinned-blocked',
    isPinned: true
  }

  it('emits no section when nothing needs the user', () => {
    const rows = buildRowsWithNeedsAttention('repo', [alpha, blocked], new Set())

    expect(rows.some((row) => row.type === 'header' && row.key === NEEDS_ATTENTION_GROUP_KEY)).toBe(
      false
    )
  })

  it('lists blocked workspaces first and keeps their own row in the project group', () => {
    const rows = buildRowsWithNeedsAttention('repo', [alpha, blocked], new Set([blocked.id]))

    expect(rows[0]).toMatchObject({
      type: 'header',
      key: NEEDS_ATTENTION_GROUP_KEY,
      icon: { kind: 'needs-attention' },
      count: 1
    })
    const keys = itemKeys(rows)
    expect(keys[0]).toBe(`${NEEDS_ATTENTION_GROUP_KEY}/wt-blocked`)
    expect(keys.filter((key) => key.endsWith('/wt-blocked'))).toHaveLength(2)
    expect(keys.filter((key) => key.endsWith('/wt-alpha'))).toHaveLength(1)
  })

  it('sits above Pinned and keeps a pinned workspace in Pinned', () => {
    const rows = buildRowsWithNeedsAttention(
      'none',
      [alpha, pinnedBlocked],
      new Set([pinnedBlocked.id])
    )
    const headerKeys = rows.flatMap((row) => (row.type === 'header' ? [row.key] : []))

    expect(headerKeys.slice(0, 2)).toEqual([NEEDS_ATTENTION_GROUP_KEY, PINNED_GROUP_KEY])
    expect(itemKeys(rows)).toContain(`${PINNED_GROUP_KEY}/wt-pinned-blocked`)
  })

  it('keeps the header but hides its rows when collapsed', () => {
    const rows = buildRowsWithNeedsAttention(
      'repo',
      [alpha, blocked],
      new Set([blocked.id]),
      new Set([NEEDS_ATTENTION_GROUP_KEY])
    )

    expect(rows[0]).toMatchObject({ type: 'header', key: NEEDS_ATTENTION_GROUP_KEY, count: 1 })
    expect(itemKeys(rows)).not.toContain(`${NEEDS_ATTENTION_GROUP_KEY}/wt-blocked`)
  })

  it('only lists workspaces that pass the sidebar filters', () => {
    const rows = buildRowsWithNeedsAttention('repo', [alpha], new Set([blocked.id]))

    expect(rows.some((row) => row.type === 'header' && row.key === NEEDS_ATTENTION_GROUP_KEY)).toBe(
      false
    )
  })

  it('lists a blocked parent and child flat, and never becomes their reveal target', () => {
    const parent = { ...blocked, instanceId: 'parent-instance' }
    const child = { ...worktree, id: 'wt-child', instanceId: 'child-instance' }
    const lineage: WorktreeLineage = {
      worktreeId: child.id,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'cli',
      capture: { source: 'terminal-context', confidence: 'inferred' },
      createdAt: 1
    }
    const plan = planWithNeedsAttention('repo', [parent, child], new Set([parent.id, child.id]), {
      [child.id]: lineage
    })
    const items = plan.render(new Set()).filter((row) => row.type === 'item')
    const depths = (inNeedsYou: boolean): number[] =>
      items.flatMap((row) =>
        (row.sectionKey === NEEDS_ATTENTION_GROUP_KEY) === inNeedsYou ? [row.depth] : []
      )

    expect(depths(false)).toEqual([0, 1])
    expect(depths(true)).toEqual([0, 0])
    expect(plan.occurrencePlan.preferredByIdentity.size).toBe(2)
    for (const occurrence of plan.occurrencePlan.preferredByIdentity.values()) {
      expect(occurrence.sectionKey).not.toBe(NEEDS_ATTENTION_GROUP_KEY)
    }
  })
})
