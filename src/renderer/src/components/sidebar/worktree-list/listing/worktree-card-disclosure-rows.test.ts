import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { buildWorktreeOccurrencePlan } from '../../../../../../shared/worktree-occurrence-plan'
import { appendWorktreeRows } from '../../../../../../shared/sidebar-list/row-builders'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeLineage } from '@/store/slices/worktrees/metadata/workspace-lineage.test-fixture'
import { buildSidebarRowPlan } from '../grouping/build-rows.test-fixture'
import { buildWorktreeLineageRanges } from '../../../../../../shared/sidebar-list/worktree-lineage-range'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { projectCardDisclosureRows } from './worktree-card-disclosure-rows'
import {
  selectCollapsedLineageSlot,
  selectLineageLatestAt,
  selectLineageChildCounts
} from '../../worktree-card-slot-rollup'
import { useAppStore } from '@/store'

it('projects folded rows before navigation and reveals the selected host’s nested workspace', () => {
  const worktrees = ['parent', 'child', 'grandchild', 'sibling'].map((id, index) =>
    makeWorktree({
      id,
      repoId: 'repo1',
      hostId: 'local',
      instanceId: `${id}-instance`,
      lastActivityAt: index + 1,
      isUnread: id === 'grandchild'
    })
  )
  const lineage = {
    child: makeLineage({ worktreeId: 'child', parentWorktreeId: 'parent' }),
    grandchild: makeLineage({
      worktreeId: 'grandchild',
      worktreeInstanceId: 'grandchild-instance',
      parentWorktreeId: 'child',
      parentWorktreeInstanceId: 'child-instance'
    })
  }
  const plan = buildSidebarRowPlan(
    'none',
    worktrees,
    new Map([['repo1', TEST_REPO]]),
    null,
    new Set(),
    undefined,
    undefined,
    undefined,
    lineage,
    undefined,
    true
  )
  const rows = plan.render(new Set())
  const ranges = buildWorktreeLineageRanges(plan.occurrencePlan)
  const selection = { active: null, reveal: null, revealRow: undefined, sendTarget: undefined }
  const ids = (projected: HostSectionRow[]) =>
    projected.flatMap((row) => (row.type === 'item' ? [row.worktree.id] : []))
  expect(ids(projectCardDisclosureRows(rows, ranges, new Map(), selection))).toEqual([
    'parent',
    'sibling'
  ])
  expect(
    ids(
      projectCardDisclosureRows(rows, ranges, new Map(), {
        ...selection,
        active: composeWorktreeHostIdentity('local', 'grandchild')
      })
    )
  ).toEqual(['parent', 'child', 'grandchild', 'sibling'])
  expect(
    ids(
      projectCardDisclosureRows(rows, ranges, new Map(), {
        ...selection,
        reveal: { worktreeId: 'grandchild', executionHostId: 'ssh:other', behavior: 'auto' }
      })
    )
  ).toEqual(['parent', 'sibling'])
  const parent = rows.find((row) => row.type === 'item' && row.worktree.id === 'parent')!
  if (parent.type !== 'item') {
    throw new Error('Parent row missing')
  }
  const parentRange = ranges.get(parent.rowKey)!
  const state = { ...useAppStore.getState(), worktreesByRepo: { repo1: worktrees } }
  expect(selectCollapsedLineageSlot(state, parentRange)).toEqual({
    kind: 'unread',
    at: 3,
    manual: false
  })
  expect(selectLineageLatestAt(state, parentRange)).toBe(3)
  expect(
    selectLineageChildCounts(state, [composeWorktreeHostIdentity('local', 'child')], parentRange)
  ).toEqual({ needs: 0, failed: 0, unread: 1, working: 0 })
})

it('folds folder-backed roots and retains hidden attention and host-qualified reveal paths', () => {
  const folder: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: 'project',
    name: 'Release',
    folderPath: '/release',
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
  const projectGroup: ProjectGroup = {
    id: 'project',
    name: 'Project',
    parentPath: '/release',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
  const root = folderWorkspaceToWorktree(folder)
  const child = makeWorktree({
    id: 'nested',
    repoId: 'repo1',
    hostId: 'ssh:box',
    isUnread: true,
    lastActivityAt: 45
  })
  const identity = composeWorktreeHostIdentity('ssh:box', 'nested')
  const plan = buildWorktreeOccurrencePlan({
    rows: [root, child],
    identityOf: (row) => composeWorktreeHostIdentity(row.hostId, row.id),
    childrenByParentIdentity: new Map([
      [composeWorktreeHostIdentity(root.hostId, root.id), [child]]
    ]),
    isPinned: () => false,
    duplicatePinned: false,
    sectionsOf: ({ natural }) => [{ key: 'all', items: natural }]
  })
  const rows: Row[] = []
  appendWorktreeRows(rows, () => TEST_REPO, plan, {
    sectionKey: 'all',
    groupDepth: 0,
    collapsedGroups: new Set(),
    folderPairByIdentity: new Map([
      [composeWorktreeHostIdentity(root.hostId, root.id), { folderWorkspace: folder, projectGroup }]
    ])
  })
  const ranges = buildWorktreeLineageRanges(plan)
  const selection = { active: null, reveal: null, revealRow: undefined, sendTarget: undefined }
  const folded = projectCardDisclosureRows(rows, ranges, new Map(), selection)
  expect(folded.map((row) => row.type)).toEqual(['folder-workspace'])
  const row = folded[0]!
  if (row.type !== 'folder-workspace' || !row.lineageDescendantIdentities) {
    throw new Error('Missing folder range')
  }
  expect(row.lineageChildIdentities).toEqual([identity])
  expect(
    selectCollapsedLineageSlot(
      { ...useAppStore.getState(), worktreesByRepo: { repo1: [child] } },
      row.lineageDescendantIdentities
    )
  ).toEqual({ kind: 'unread', at: 45, manual: false })
  expect(
    projectCardDisclosureRows(rows, ranges, new Map(), {
      ...selection,
      reveal: { worktreeId: 'nested', executionHostId: 'ssh:box', behavior: 'auto' }
    }).map((row) => row.type)
  ).toEqual(['folder-workspace', 'item'])
  expect(
    projectCardDisclosureRows(rows, ranges, new Map(), {
      ...selection,
      reveal: { worktreeId: 'nested', executionHostId: 'local', behavior: 'auto' }
    }).map((row) => row.type)
  ).toEqual(['folder-workspace'])
})
