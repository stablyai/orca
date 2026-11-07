import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { makeLineage } from '@/store/slices/worktrees-slice-test-fixtures'
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
