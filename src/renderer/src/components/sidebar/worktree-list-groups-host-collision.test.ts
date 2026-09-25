/**
 * STA-4343: correct host-qualified routing is useless if the user cannot select
 * the row it would route to.
 *
 * A repo id can be registered once per execution host, so the same repo checked
 * out at the same path on the local host and on an SSH host publishes the SAME
 * `repoId::path` workspace id twice. The sidebar collapsed that to one row, which
 * meant the other host's workspace could never be confirmed — and a delete
 * confirmed on the surviving row carried the wrong host.
 */
import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
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
  // Only one repo can be keyed per id in the repo map; the SSH row still has to
  // render, so the collision must be resolved from the worktree rows themselves.
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

  // The same-host duplicate that this dedup was originally built for collapses a
  // layer up, in the store index — see worktree-host-collision-index.test.ts.
})

// Referenced so the SSH repo fixture documents the two-host registration this
// scenario requires, even though buildRows keys its repo map by id alone.
export const SSH_REPO_FIXTURE = sshRepo
