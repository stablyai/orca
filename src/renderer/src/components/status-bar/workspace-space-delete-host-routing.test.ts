/**
 * STA-4343: the Space Manager's ORDINARY delete must route to the row's host.
 *
 * The Space scan lists one row per execution host, so two rows can share a
 * `repoId::path` worktree id. The force-delete path carried `executionHostId`;
 * the ordinary Delete one line above it passed a bare id, which resolves through
 * the id-keyed lookup and lands on whichever host happens to be first. Clicking
 * Delete on the SSH row therefore deleted the LOCAL checkout.
 *
 * A Space row carries no `instanceId` (see WorkspaceSpaceWorktree), so the fix
 * cannot hand-build an identity — it has to resolve the store row on that host
 * and pass the store row's own identity, or the confirmed-target check rejects
 * every Space delete as stale.
 */
import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getSelectedDeletableWorkspaceRows,
  getWorkspaceSpaceWorktreeIdentity
} from './workspace-space-delete-selection'
import {
  resolveWorktreeBatchDeleteTargets,
  toWorktreeDeleteIdentities
} from '../sidebar/worktree-delete-request'

const SHARED_ID = 'repo-1::/work/orca'
const LOCAL: ExecutionHostId = 'local'
const SSH: ExecutionHostId = 'ssh:build-box'

function spaceRow(executionHostId: ExecutionHostId): WorkspaceSpaceWorktree {
  return {
    worktreeId: SHARED_ID,
    executionHostId,
    displayName: 'orca',
    path: '/work/orca',
    status: 'ok',
    canDelete: true,
    sizeBytes: 1
  } as WorkspaceSpaceWorktree
}

function storeRow(hostId: ExecutionHostId): Worktree {
  return {
    id: SHARED_ID,
    // A Space row has no instanceId; the store row does, and that is the one
    // the confirmed-target check compares against.
    instanceId: `instance-${hostId}`,
    repoId: 'repo-1',
    path: '/work/orca',
    isMainWorktree: false,
    hostId
  } as Worktree
}

const localStoreRow = storeRow(LOCAL)
const sshStoreRow = storeRow(SSH)

/** Stands in for getWorktreeOnHostFromState: resolve on the named host. */
function lookupOnHost(worktreeId: string, hostId: ExecutionHostId | undefined) {
  const matches = [localStoreRow, sshStoreRow].filter((row) => row.id === worktreeId)
  return hostId ? matches.find((row) => row.hostId === hostId) : matches[0]
}

/** The panel's delete path: Space row -> store row on ITS host -> identity. */
function identitiesForSpaceDelete(targets: readonly WorkspaceSpaceWorktree[]) {
  return toWorktreeDeleteIdentities(
    targets.flatMap((target) => {
      const row = lookupOnHost(target.worktreeId, target.executionHostId ?? undefined)
      return row ? [row] : []
    })
  )
}

describe('Space Manager delete routes to the row host', () => {
  it('deletes the SSH row when the SSH row is the one clicked', () => {
    const targets = resolveWorktreeBatchDeleteTargets(
      identitiesForSpaceDelete([spaceRow(SSH)]),
      lookupOnHost
    )

    // The local row is listed first, so a bare-id delete would resolve to it.
    expect(targets?.map((row) => row.hostId)).toEqual([SSH])
  })

  it('deletes the local row when the local row is the one clicked', () => {
    const targets = resolveWorktreeBatchDeleteTargets(
      identitiesForSpaceDelete([spaceRow(LOCAL)]),
      lookupOnHost
    )

    expect(targets?.map((row) => row.hostId)).toEqual([LOCAL])
  })

  it('carries the store row instanceId so the confirmed-target check accepts it', () => {
    // Regression guard: hand-building {id, hostId} with no instanceId would make
    // resolveWorktreeBatchDeleteTargets refuse every Space delete instead.
    const identities = identitiesForSpaceDelete([spaceRow(SSH)])

    expect(identities).toEqual([{ id: SHARED_ID, instanceId: `instance-${SSH}`, hostId: SSH }])
    expect(resolveWorktreeBatchDeleteTargets(identities, lookupOnHost)).not.toBeNull()
  })

  it('selects only the confirmed host when two rows share an id', () => {
    const local = spaceRow(LOCAL)
    const ssh = spaceRow(SSH)
    const selected = getSelectedDeletableWorkspaceRows(
      [local, ssh],
      new Set([getWorkspaceSpaceWorktreeIdentity(ssh)])
    )
    expect(selected).toEqual([ssh])

    const targets = resolveWorktreeBatchDeleteTargets(
      identitiesForSpaceDelete(selected),
      lookupOnHost
    )

    expect(targets?.map((row) => row.hostId)).toEqual([SSH])
  })

  it('keeps both rows when both host-qualified identities are selected', () => {
    const local = spaceRow(LOCAL)
    const ssh = spaceRow(SSH)
    const selected = getSelectedDeletableWorkspaceRows(
      [local, ssh],
      new Set([getWorkspaceSpaceWorktreeIdentity(local), getWorkspaceSpaceWorktreeIdentity(ssh)])
    )

    expect(selected).toEqual([local, ssh])
    expect(
      resolveWorktreeBatchDeleteTargets(identitiesForSpaceDelete(selected), lookupOnHost)?.map(
        (row) => row.hostId
      )
    ).toEqual([LOCAL, SSH])
  })
})
