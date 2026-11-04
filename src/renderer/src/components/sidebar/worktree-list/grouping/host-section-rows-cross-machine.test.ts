import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import {
  addHostSectionRows,
  type HostSectionRow
} from '../../../../../../shared/sidebar-list/host-section-rows'

const LOCAL = { id: 'local', path: '/local', displayName: 'local', badgeColor: '#000', addedAt: 0 }
const SERVER = { ...LOCAL, id: 'server', path: '/server', displayName: 'server' }

function item(
  id: string,
  repo: Repo,
  extra: { hostId?: 'runtime:env-1'; depth?: number; hostContextLabel?: string } = {}
): Extract<Row, { type: 'item' }> {
  return {
    type: 'item',
    rowKey: id,
    sectionKey: 'all',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: host sections read only id, repoId and hostId.
    worktree: {
      id,
      repoId: repo.id,
      path: `/${id}`,
      displayName: id,
      ...(extra.hostId ? { hostId: extra.hostId } : {})
    } as Worktree,
    repo,
    depth: extra.depth ?? 0,
    groupDepth: 0,
    isLastLineageChild: true,
    lineageChildCount: 0,
    ...(extra.hostContextLabel ? { hostContextLabel: extra.hostContextLabel } : {})
  }
}

function keyOf(row: HostSectionRow): string {
  return row.type === 'item' ? row.worktree.id : row.key
}

describe('addHostSectionRows with a parent on another machine', () => {
  it("keeps the nested child in its parent's section, labelled with its own machine", () => {
    const label = { hostId: 'runtime:env-1', hostContextLabel: 'build-box' } as const
    const sectioned = addHostSectionRows({
      rows: [
        item('parent', LOCAL),
        item('child', SERVER, { ...label, depth: 1 }),
        item('other', SERVER, label)
      ],
      localHostLabel: 'Local Mac',
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        {
          id: 'runtime:env-1',
          kind: 'runtime',
          label: 'build-box',
          detail: 'Server',
          health: 'available'
        }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })
    expect(
      sectioned.map((row) => [
        keyOf(row),
        row.type === 'item' ? (row.hostContextLabel ?? null) : null
      ])
    ).toEqual([
      ['host:local', null],
      ['parent', null],
      ['child', 'build-box'],
      ['host:runtime:env-1', null],
      ['other', null]
    ])
  })
})
