import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { HostSectionRow } from '../../host-section-rows'
import {
  buildWorktreeLineageSiblingGroupIndex,
  resolveWorktreeLineageSiblingSelection
} from './lineage-sibling-groups'

const NATURAL_SECTION = 'repo:repo-1'

function item(
  id: string,
  depth: number,
  options: { rowKey?: string; sectionKey?: string; hostId?: ExecutionHostId } = {}
): Extract<HostSectionRow, { type: 'item' }> {
  return {
    type: 'item',
    rowKey: options.rowKey ?? `row:${id}`,
    sectionKey: options.sectionKey ?? NATURAL_SECTION,
    worktree: { id, repoId: 'repo-1', hostId: options.hostId } as never,
    repo: { id: 'repo-1' } as never,
    depth,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

function naturalIds(rows: readonly HostSectionRow[]): Set<string> {
  return new Set(
    rows.flatMap((row) =>
      row.type === 'item' && row.sectionKey !== 'pinned' ? [row.worktree.id] : []
    )
  )
}

describe('buildWorktreeLineageSiblingGroupIndex', () => {
  it('builds one ordered group per direct parent at every visible depth', () => {
    const rows = [
      item('parent', 0),
      item('child-a', 1),
      item('grandchild-a', 2),
      item('grandchild-b', 2),
      item('child-b', 1),
      item('other-parent', 0),
      item('other-child-a', 1),
      item('other-child-b', 1)
    ]

    const index = buildWorktreeLineageSiblingGroupIndex(rows, naturalIds(rows))

    expect(index.groups).toEqual([
      {
        key: 'lineage-siblings:row:parent',
        rows: [
          { rowKey: 'row:child-a', worktreeId: 'child-a' },
          { rowKey: 'row:child-b', worktreeId: 'child-b' }
        ]
      },
      {
        key: 'lineage-siblings:row:child-a',
        rows: [
          { rowKey: 'row:grandchild-a', worktreeId: 'grandchild-a' },
          { rowKey: 'row:grandchild-b', worktreeId: 'grandchild-b' }
        ]
      },
      {
        key: 'lineage-siblings:row:other-parent',
        rows: [
          { rowKey: 'row:other-child-a', worktreeId: 'other-child-a' },
          { rowKey: 'row:other-child-b', worktreeId: 'other-child-b' }
        ]
      }
    ])
  })

  it('keys same-id parent families by row key and retains their execution host', () => {
    const rows = [
      item('parent', 0, { rowKey: 'host:local:parent', hostId: 'local' }),
      item('shared-child', 1, { rowKey: 'host:local:shared', hostId: 'local' }),
      item('local-b', 1, { rowKey: 'host:local:b', hostId: 'local' }),
      item('parent', 0, { rowKey: 'host:ssh:parent', hostId: 'ssh:host-b' }),
      item('shared-child', 1, { rowKey: 'host:ssh:shared', hostId: 'ssh:host-b' }),
      item('ssh-b', 1, { rowKey: 'host:ssh:b', hostId: 'ssh:host-b' })
    ]

    const index = buildWorktreeLineageSiblingGroupIndex(rows, naturalIds(rows))

    expect(index.groups.map((group) => group.key)).toEqual([
      'lineage-siblings:host:local:parent',
      'lineage-siblings:host:ssh:parent'
    ])
    const sshSelection = resolveWorktreeLineageSiblingSelection(index, 'host:ssh:shared', [
      'shared-child'
    ])
    expect(Array.from(sshSelection?.executionHostIdByWorktreeId ?? [])).toEqual([
      ['shared-child', 'ssh:host-b'],
      ['ssh-b', 'ssh:host-b']
    ])
  })

  it('ignores duplicate pinned families when natural rows are present', () => {
    const rows = [
      item('parent', 0, { rowKey: 'pinned:parent', sectionKey: 'pinned' }),
      item('child-a', 1, { rowKey: 'pinned:a', sectionKey: 'pinned' }),
      item('child-b', 1, { rowKey: 'pinned:b', sectionKey: 'pinned' }),
      item('parent', 0),
      item('child-a', 1),
      item('child-b', 1)
    ]

    const index = buildWorktreeLineageSiblingGroupIndex(rows, naturalIds(rows))

    expect(index.groups).toHaveLength(1)
    expect(index.groups[0]?.key).toBe('lineage-siblings:row:parent')
  })
})

describe('resolveWorktreeLineageSiblingSelection', () => {
  it('preserves rendered order and rejects mixed-parent selections', () => {
    const rows = [
      item('parent-a', 0),
      item('child-a', 1),
      item('child-b', 1),
      item('child-c', 1),
      item('parent-b', 0),
      item('other-a', 1),
      item('other-b', 1)
    ]
    const index = buildWorktreeLineageSiblingGroupIndex(rows, naturalIds(rows))

    expect(
      resolveWorktreeLineageSiblingSelection(index, 'row:child-c', ['child-c', 'child-a'])
    ).toMatchObject({ draggedIds: ['child-a', 'child-c'] })
    expect(
      resolveWorktreeLineageSiblingSelection(index, 'row:child-a', ['child-a', 'other-a'])
    ).toBeNull()
  })
})
