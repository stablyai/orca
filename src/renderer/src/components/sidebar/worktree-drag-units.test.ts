import { describe, expect, it } from 'vitest'
import {
  getFullDropIndexForWorktreeDragUnit,
  getWorktreeDragUnitGroups
} from './worktree-drag-units'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'

// Unit members are host identities; these rows carry no host.
const k = (id: string): string => composeWorktreeHostIdentity(undefined, id)

function header(key: string): { type: 'header'; key: string } {
  return { type: 'header', key }
}

function item(
  id: string,
  depth = 0,
  sectionKey = 'all'
): { type: 'item'; worktree: { id: string }; depth: number; sectionKey: string } {
  return { type: 'item', worktree: { id }, depth, sectionKey }
}

function importedCard(): { type: 'imported-worktrees-card' } {
  return { type: 'imported-worktrees-card' }
}

describe('getWorktreeDragUnitGroups', () => {
  it('treats expanded lineage descendants as part of the parent drag unit', () => {
    const groups = getWorktreeDragUnitGroups([
      header('all'),
      item('parent'),
      item('child', 1),
      item('grandchild', 2),
      item('sibling')
    ])

    expect(groups).toEqual([
      {
        key: 'all',
        worktreeIds: [k('parent'), k('sibling')],
        units: [
          { worktreeId: k('parent'), worktreeIds: [k('parent'), k('child'), k('grandchild')] },
          { worktreeId: k('sibling'), worktreeIds: [k('sibling')] }
        ]
      }
    ])
  })

  it('ignores imported worktree card rows without splitting drag groups', () => {
    const groups = getWorktreeDragUnitGroups([
      header('repo:one'),
      item('main'),
      importedCard(),
      item('feature'),
      header('repo:two'),
      importedCard(),
      item('other')
    ])

    expect(groups).toEqual([
      {
        key: 'repo:one',
        worktreeIds: [k('main'), k('feature')],
        units: [
          { worktreeId: k('main'), worktreeIds: [k('main')] },
          { worktreeId: k('feature'), worktreeIds: [k('feature')] }
        ]
      },
      {
        key: 'repo:two',
        worktreeIds: [k('other')],
        units: [{ worktreeId: k('other'), worktreeIds: [k('other')] }]
      }
    ])
  })

  it('includes pinned rows when they are the only rendered copy', () => {
    const groups = getWorktreeDragUnitGroups([
      header('pinned'),
      item('pinned-copy', 0, 'pinned'),
      item('other-pinned', 0, 'pinned')
    ])

    expect(groups).toEqual([
      {
        key: 'pinned',
        worktreeIds: [k('pinned-copy'), k('other-pinned')],
        units: [
          { worktreeId: k('pinned-copy'), worktreeIds: [k('pinned-copy')] },
          { worktreeId: k('other-pinned'), worktreeIds: [k('other-pinned')] }
        ]
      }
    ])
  })

  it('uses natural drag units when pinned rows have duplicate natural copies', () => {
    const groups = getWorktreeDragUnitGroups([
      header('pinned'),
      item('pinned-copy', 0, 'pinned'),
      header('all'),
      item('pinned-copy'),
      item('other')
    ])

    expect(groups).toEqual([
      {
        key: 'all',
        worktreeIds: [k('pinned-copy'), k('other')],
        units: [
          { worktreeId: k('pinned-copy'), worktreeIds: [k('pinned-copy')] },
          { worktreeId: k('other'), worktreeIds: [k('other')] }
        ]
      }
    ])
  })

  it('keeps same-id copies on two hosts as separate units', () => {
    const onHost = (hostId: ExecutionHostId, sectionKey = 'all') => ({
      type: 'item' as const,
      worktree: { id: 'repo::/w/same', hostId },
      depth: 0,
      sectionKey
    })
    const groups = getWorktreeDragUnitGroups([
      header('pinned'),
      onHost('ssh:vm-a', 'pinned'),
      header('all'),
      onHost('ssh:vm-b'),
      onHost('ssh:vm-c')
    ])

    expect(groups.map((group) => group.worktreeIds)).toEqual([
      // The pinned copy is the only one on vm-a, so it keeps its own pinned slot.
      ['ssh:vm-a|repo::/w/same'],
      ['ssh:vm-b|repo::/w/same', 'ssh:vm-c|repo::/w/same']
    ])
  })
})

describe('getFullDropIndexForWorktreeDragUnit', () => {
  it('maps visual unit drop indexes back to full row indexes', () => {
    const groups = getWorktreeDragUnitGroups([
      header('all'),
      item('parent'),
      item('child', 1),
      item('sibling')
    ])

    expect(
      getFullDropIndexForWorktreeDragUnit({
        groups,
        sourceGroupKey: 'all',
        dropIndex: 2
      })
    ).toBe(3)
  })
})
