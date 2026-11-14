import { describe, expect, it } from 'vitest'
import {
  buildWorktreeSortLabels,
  compareWorktreeSortLabel,
  type WorktreeSortLabelInput
} from '../../../../../../shared/sidebar-list/sorting/smart-sort'

describe('worktree sort label ordering', () => {
  it('breaks an equal-label tie by host-qualified id, independent of input order', () => {
    const local: WorktreeSortLabelInput = {
      id: 'shared',
      hostId: 'local',
      displayName: 'same',
      path: '/tmp/alpha-0'
    }
    const remote: WorktreeSortLabelInput = {
      ...local,
      hostId: 'ssh:box',
      path: '/tmp/Alpha-1/'
    }
    const labels = buildWorktreeSortLabels([local, remote])
    const compare = (a: WorktreeSortLabelInput, b: WorktreeSortLabelInput): number =>
      compareWorktreeSortLabel(a, b, labels)
    expect([remote, local].sort(compare)).toEqual([local, remote])
    expect([local, remote].sort(compare)).toEqual([local, remote])
  })
})
