/** Single-location pinned rows need host attribution because they have no natural-section duplicate. */
import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import type { Row } from '../../../../shared/sidebar-list/row-types'
import {
  LOCAL_HOST_LABEL,
  repo,
  worktree,
  remoteRepo,
  remoteWorktree
} from './worktree-list-groups-test-fixtures'
import type { Worktree } from '../../../../shared/worktree/types'

const hostLabelById = new Map([
  ['local', LOCAL_HOST_LABEL],
  ['ssh:gpu-vm', 'gpu-vm']
])

function buildPinnedRows(
  worktrees: Worktree[],
  groupBy: 'none' | 'repo' | 'workspace-status' = 'repo',
  showPinnedWorktreesInGroups = false
): Row[] {
  return buildRows(
    groupBy,
    worktrees,
    new Map([
      [repo.id, repo],
      [remoteRepo.id, remoteRepo]
    ]),
    null,
    new Set(),
    undefined,
    undefined,
    undefined,
    {},
    new Map(worktrees.map((candidate) => [candidate.id, candidate])),
    false,
    { showPinnedWorktreesInGroups } as never,
    [],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    [],
    hostLabelById
  )
}

function itemRows(rows: Row[]): { id: string; sectionKey: string; hostContextLabel?: string }[] {
  return rows.flatMap((row) =>
    row.type === 'item'
      ? [
          {
            id: row.worktree.id,
            sectionKey: row.sectionKey,
            hostContextLabel: row.hostContextLabel
          }
        ]
      : []
  )
}

describe('pinned rows on a multi-host sidebar', () => {
  it.each(['repo', 'workspace-status', 'none'] as const)(
    'labels a pinned remote worktree in the Pinned section (%s grouping)',
    (groupBy) => {
      const pinnedRemote: Worktree = { ...remoteWorktree, isPinned: true }
      const rows = itemRows(buildPinnedRows([worktree, pinnedRemote], groupBy))

      expect(rows.filter((row) => row.id === pinnedRemote.id)).toEqual([
        { id: pinnedRemote.id, sectionKey: 'pinned', hostContextLabel: 'gpu-vm' }
      ])
      expect(rows.find((row) => row.id === worktree.id)?.hostContextLabel).toBe(LOCAL_HOST_LABEL)
    }
  )

  it('draws no badge on a single-host sidebar even with a pinned row', () => {
    const pinnedLocal: Worktree = { ...worktree, isPinned: true }
    const localOnly: Worktree = { ...worktree, id: 'wt-local-2', displayName: 'local-2' }
    const rows = itemRows(buildPinnedRows([pinnedLocal, localOnly]))

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.hostContextLabel).toBeUndefined()
    }
  })
})
