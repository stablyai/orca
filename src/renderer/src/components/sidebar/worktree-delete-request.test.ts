/** Resolve confirmation-dialog and batch-shortcut deletes by host; same-ID twins must remain separately reachable. */
import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  readWorktreeDeleteIdentities,
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

  it('reaches the second host row even though the local row is listed first', () => {
    const identities = toWorktreeDeleteIdentities([sshRow])

    const targets = resolveWorktreeBatchDeleteTargets(identities, lookupFrom([localRow, sshRow]))

    expect(targets).toEqual([sshRow])
    expect(targets?.[0]?.hostId).toBe(SSH)
  })

  it('resolves the local row when that is the one confirmed', () => {
    const targets = resolveWorktreeBatchDeleteTargets(
      toWorktreeDeleteIdentities([localRow]),
      lookupFrom([localRow, sshRow])
    )

    expect(targets?.[0]?.hostId).toBe(LOCAL)
  })

  it('keeps both hosts when both rows are confirmed in one batch', () => {
    const targets = resolveWorktreeBatchDeleteTargets(
      toWorktreeDeleteIdentities([localRow, sshRow]),
      lookupFrom([localRow, sshRow])
    )

    // Deduping on the bare id here would drop one confirmed workspace.
    expect(targets?.map((entry) => entry.hostId)).toEqual([LOCAL, SSH])
  })

  it('refuses when the confirmed host no longer has a row', () => {
    const targets = resolveWorktreeBatchDeleteTargets(
      toWorktreeDeleteIdentities([sshRow]),
      lookupFrom([localRow])
    )

    expect(targets).toBeNull()
  })

  it('refuses when the row on the confirmed host was replaced', () => {
    const replaced = row(SSH, { instanceId: 'instance-recreated' })

    const targets = resolveWorktreeBatchDeleteTargets(
      toWorktreeDeleteIdentities([sshRow]),
      lookupFrom([localRow, replaced])
    )

    expect(targets).toBeNull()
  })

  it('keeps first-wins for a bare id request that names no host', () => {
    const targets = resolveWorktreeBatchDeleteTargets([SHARED_ID], lookupFrom([localRow, sshRow]))

    expect(targets?.[0]?.hostId).toBe(LOCAL)
  })

  it('skips a main worktree without failing the batch', () => {
    const main = row(LOCAL, { isMainWorktree: true })

    const targets = resolveWorktreeBatchDeleteTargets(
      toWorktreeDeleteIdentities([main]),
      lookupFrom([main])
    )

    expect(targets).toEqual([])
  })
})

describe('readWorktreeDeleteIdentities', () => {
  it('carries the host through the modal data round trip', () => {
    // The host must survive unknown modal-data parsing to preserve the confirmed delete target.
    const parsed = readWorktreeDeleteIdentities([
      { id: SHARED_ID, instanceId: 'instance-ssh', hostId: SSH }
    ])

    expect(parsed).toEqual([{ id: SHARED_ID, instanceId: 'instance-ssh', hostId: SSH }])
  })

  it('drops a host that is not a valid execution host id', () => {
    const parsed = readWorktreeDeleteIdentities([{ id: SHARED_ID, hostId: '   ' }])

    expect(parsed).toEqual([{ id: SHARED_ID, instanceId: undefined }])
  })
})
