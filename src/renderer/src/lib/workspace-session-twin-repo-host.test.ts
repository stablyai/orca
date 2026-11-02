import { describe, expect, it } from 'vitest'
import {
  TWIN_REPO_HOST_CASES,
  TWIN_WORKTREE_ID,
  twinPartitionSessions
} from '../../../shared/twin-repo-host-routing.test-fixture'
import { mergeWorkspaceSessionsWithHostShadow } from './workspace-session-host-contention'
import { buildHostIdByWorktreeId } from './workspace-session-host-persistence'

// Main's router is checked against the same table in runtime-workspace-session-controller-twin-repo.test.ts.
describe("the window's save partition for a repo id on two hosts", () => {
  it.each(TWIN_REPO_HOST_CASES)('$name', ({ repos, catalog, saved, staleOn, expected }) => {
    // As startup does: read every partition, then route with the partition each row came from.
    const read = mergeWorkspaceSessionsWithHostShadow(
      Object.fromEntries(twinPartitionSessions(saved, staleOn))
    )
    const hostIdOf = buildHostIdByWorktreeId({
      repos,
      worktreesByRepo: { repo: catalog },
      contestedPrimaryHostBySessionKey: read.primaryHostBySessionKey
    })
    expect(hostIdOf(TWIN_WORKTREE_ID)).toBe(expected)
  })
})
