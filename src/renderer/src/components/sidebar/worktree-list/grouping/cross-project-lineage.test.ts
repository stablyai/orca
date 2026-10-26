import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  repo,
  worktree,
  project,
  projectHostSetups
} from '../../worktree-list-groups-test-fixtures'
import { makeProjectGroup } from '../../folder-workspace-composer-submit-fixtures'
import { getWorktreeRevealCollapsedGroupKeys } from '../navigation/worktree-reveal-group-keys'
import { buildRows, buildSidebarRowPlan } from './build-rows.test-fixture'
import {
  getWorktreeLineageGroupKey,
  getProjectGroupHeaderKey,
  PINNED_GROUP_KEY
} from '../../../../../../shared/sidebar-list/group-keys'

const childRepo = { ...repo, id: 'child-repo', displayName: 'Child project', path: '/tmp/child' }
const repos = new Map([
  [repo.id, repo],
  [childRepo.id, childRepo]
])
const parent: Worktree = {
  ...worktree,
  id: 'parent',
  instanceId: 'parent-instance',
  isMainWorktree: true
}
const child: Worktree = {
  ...worktree,
  id: 'child',
  instanceId: 'child-instance',
  repoId: childRepo.id,
  path: '/tmp/child-worktree'
}
const lineage: WorktreeLineage = {
  worktreeId: child.id,
  worktreeInstanceId: 'child-instance',
  parentWorktreeId: parent.id,
  parentWorktreeInstanceId: 'parent-instance',
  origin: 'cli',
  capture: { source: 'terminal-context', confidence: 'inferred' },
  createdAt: 1
}
const lineageById = { [child.id]: lineage }
const worktreeMap = new Map([
  [parent.id, parent],
  [child.id, child]
])

const grouping = {
  projects: [project],
  projectHostSetups: [repo, childRepo].map((checkout) => ({
    ...projectHostSetups[0]!,
    id: checkout.id,
    repoId: checkout.id,
    path: checkout.path,
    displayName: checkout.displayName
  }))
}

describe('cross-project sidebar lineage', () => {
  it('ranks by actual owner and keeps notices/actions there while counting displayed children', () => {
    const gammaRepo = { ...repo, id: 'gamma', displayName: 'Gamma' }
    const rows = buildRows(
      'repo',
      [
        { ...parent, lastActivityAt: 1 },
        { ...child, lastActivityAt: 100 },
        { ...worktree, id: 'gamma', repoId: gammaRepo.id, lastActivityAt: 50 }
      ],
      new Map([...repos, [gammaRepo.id, gammaRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      'recent',
      lineageById,
      worktreeMap,
      true,
      undefined,
      [],
      new Set(),
      new Map([[childRepo.id, { repo: childRepo, hiddenWorktrees: [] }]]),
      new Map(),
      [{ creationId: 'creating-child', repoId: childRepo.id }]
    )
    expect(
      rows.filter((row) => row.type === 'header').map((row) => [row.repo?.id, row.count])
    ).toEqual([
      [childRepo.id, 0],
      [gammaRepo.id, 1],
      [repo.id, 2]
    ])
    expect(rows.find((row) => row.type === 'item' && row.worktree.id === child.id)).toMatchObject({
      repo: childRepo,
      sectionKey: `repo:${repo.id}`,
      depth: 1
    })
    const nextSection = rows.findIndex(
      (row) => row.type === 'header' && row.repo?.id === gammaRepo.id
    )
    expect(rows.slice(1, nextSection).map((row) => row.type)).toEqual([
      'imported-worktrees-card',
      'pending-creation'
    ])
    expect(rows.find((row) => row.type === 'pending-creation')).toMatchObject({ repo: childRepo })
  })

  it.each(['single-location', 'duplicate-in-groups'] as const)(
    'reveals deep separate-checkout occurrences without changing their owner (%s)',
    (policy) => {
      const group = makeProjectGroup()
      const parentRepo = { ...repo, projectGroupId: group.id }
      const repoMap = new Map([...repos, [repo.id, parentRepo]])
      const pinnedParent = { ...parent, isPinned: true }
      const grandchild = { ...child, id: 'grandchild', instanceId: 'grandchild-instance' }
      const graph = {
        ...lineageById,
        [grandchild.id]: {
          ...lineage,
          worktreeId: grandchild.id,
          worktreeInstanceId: grandchild.instanceId,
          parentWorktreeId: child.id,
          parentWorktreeInstanceId: 'child-instance'
        }
      }
      const worktrees = [grandchild, child, pinnedParent]
      const parentSection = `project:${project.id}::setup:${repo.id}`
      const plan = buildSidebarRowPlan(
        'repo',
        worktrees,
        repoMap,
        null,
        new Set(),
        undefined,
        undefined,
        undefined,
        graph,
        new Map(worktrees.map((row) => [row.id, row])),
        true,
        undefined,
        [group],
        undefined,
        undefined,
        undefined,
        undefined,
        grouping,
        undefined,
        undefined,
        'local',
        policy
      )
      const occurrence = plan.occurrencePlan.preferredByIdentity.get(
        getWorktreeHostIdentity(grandchild)
      )
      expect(occurrence).toMatchObject({
        row: { repoId: childRepo.id },
        depth: 2,
        showProjectName: false,
        sectionKey: policy === 'single-location' ? PINNED_GROUP_KEY : parentSection
      })
      expect(occurrence?.parent?.row).toBe(child)
      const collapsedGroups = new Set([
        PINNED_GROUP_KEY,
        parentSection,
        getProjectGroupHeaderKey(group.id),
        getWorktreeLineageGroupKey(parent),
        getWorktreeLineageGroupKey(child)
      ])
      expect(plan.render(collapsedGroups).some((row) => row.type === 'item')).toBe(false)
      const keys = getWorktreeRevealCollapsedGroupKeys({
        occurrencePlan: plan.occurrencePlan,
        worktree: grandchild,
        worktrees,
        worktreeLineageById: graph,
        repoMap,
        defaultHostId: 'local',
        hostScopedGroups: false,
        collapsedGroups,
        groupBy: 'repo',
        pinnedDisplayPolicy: policy,
        prCache: null,
        workspaceStatuses: [],
        projectGroups: [group]
      })
      for (const key of keys) {
        collapsedGroups.delete(key)
      }
      const rendered = plan.render(collapsedGroups).filter((row) => row.type === 'item')
      expect(rendered.map((row) => row.worktree.id)).toEqual([parent.id, child.id, grandchild.id])
      expect(rendered[2]?.occurrence).toBe(occurrence)
      expect(rendered.slice(1).map((row) => row.showProjectName)).toEqual([true, false])
    }
  )

  it('keeps a hidden parent child in its own section without redundant context', () => {
    const rows = buildRows(
      'repo',
      [child],
      repos,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      lineageById,
      worktreeMap,
      true
    )
    expect(rows.filter((row) => row.type === 'item')).toMatchObject([
      { worktree: child, sectionKey: `repo:${childRepo.id}`, depth: 0, showProjectName: false }
    ])
  })
})
