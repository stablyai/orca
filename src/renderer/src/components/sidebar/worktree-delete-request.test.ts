/** Resolve confirmation-dialog and batch-shortcut deletes by host; same-ID twins must remain separately reachable. */
import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  resolveWorktreeBatchDeleteTargets,
  toWorktreeDeleteIdentities
} from './worktree-delete-request'

const SHARED_ID = 'repo-1::/work/orca'
const LOCAL: ExecutionHostId = 'local'
const SSH: ExecutionHostId = 'ssh:build-box'

function row(hostId: ExecutionHostId | undefined, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: SHARED_ID,
    instanceId: `instance-${hostId ?? 'none'}`,
    repoId: 'repo-1',
    path: '/work/orca',
    isMainWorktree: false,
    ...(hostId ? { hostId } : {}),
    ...overrides
  } as Worktree
}

/** Stands in for the store: every host's row for an id, resolved on the named host. */
function lookupFrom(rows: readonly Worktree[]) {
  return (worktreeId: string, hostId: ExecutionHostId | undefined): Worktree | undefined => {
    const matches = rows.filter((entry) => entry.id === worktreeId)
    return hostId ? matches.find((entry) => entry.hostId === hostId) : matches[0]
  }
}

describe('resolveWorktreeBatchDeleteTargets', () => {
  const localRow = row(LOCAL)
  const sshRow = row(SSH)

  it('refuses when the row on the confirmed host was replaced', () => {
    const replaced = row(SSH, { instanceId: 'instance-recreated' })

    const targets = resolveWorktreeBatchDeleteTargets(
      toWorktreeDeleteIdentities([sshRow]),
      lookupFrom([localRow, replaced])
    )

    expect(targets).toBeNull()
  })
})
