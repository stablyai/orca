/** Same-path checkouts on different hosts share an ID but need separate selectable rows and confirmed delete targets. */
import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

const SHARED_WORKTREE_ID = 'repo-shared::/work/orca-feature'

const localRepo: Repo = { ...repo, id: 'repo-shared', path: '/work/orca' }
const sshRepo: Repo = {
  ...repo,
  id: 'repo-shared',
  path: '/work/orca',
  connectionId: 'build-box',
  executionHostId: 'ssh:build-box'
}

const localWorktree: Worktree = {
  ...worktree,
  id: SHARED_WORKTREE_ID,
  repoId: 'repo-shared',
  path: '/work/orca-feature',
  hostId: 'local',
  displayName: 'orca-feature'
}
const sshWorktree: Worktree = { ...localWorktree, hostId: 'ssh:build-box' }

function buildCollidingRows(
  worktrees: Worktree[] = [localWorktree, sshWorktree]
): ReturnType<typeof buildRows> {
  // The repo map holds one host per ID; workspace rows must preserve both hosts.
  return buildRows(
    'repo',
    worktrees,
    new Map([[localRepo.id, localRepo]]),
    null,
    new Set(),
    undefined,
    undefined,
    undefined,
    {},
    new Map(worktrees.map((candidate) => [candidate.id, candidate])),
    true
  )
}

describe('sidebar rows for a workspace id owned by two hosts', () => {
  it('renders one selectable row per host', () => {
    const itemRows = buildCollidingRows().filter((row) => row.type === 'item')

    expect(itemRows).toHaveLength(2)
    expect(itemRows.map((row) => row.worktree.hostId)).toEqual(['local', 'ssh:build-box'])
  })

  it('gives each row its own React key so neither replaces the other', () => {
    const rowKeys = buildCollidingRows()
      .filter((row) => row.type === 'item')
      .map((row) => row.rowKey)

    expect(new Set(rowKeys).size).toBe(rowKeys.length)
  })

  it('labels each row with the host it lives on', () => {
    const labels = buildCollidingRows()
      .filter((row) => row.type === 'item')
      .map((row) => row.hostContextLabel)

    expect(labels).toEqual([getExecutionHostLabel('local'), getExecutionHostLabel('ssh:build-box')])
  })

  it('counts the two hosts separately in the group header', () => {
    const header = buildCollidingRows().find((row) => row.type === 'header')

    expect(header?.count).toBe(2)
  })

  it('keeps an unpinned host row visible when its same-id peer is pinned', () => {
    const itemRows = buildCollidingRows([{ ...localWorktree, isPinned: true }, sshWorktree]).filter(
      (row) => row.type === 'item'
    )

    expect(itemRows.map((row) => row.worktree.hostId)).toEqual(['local', 'ssh:build-box'])
  })

  // The store index already collapses same-host duplicates; see worktree-host-collision-index.test.ts.
})

// Keep the second-host fixture explicit even though buildRows accepts an ID-keyed repo map.
export const SSH_REPO_FIXTURE = sshRepo
