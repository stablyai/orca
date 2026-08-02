import type { SshRepoReadoption } from '../../../../shared/ssh-types'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

type HostedWorktree = {
  id: string
  hostId?: ExecutionHostId
}

function reconcileRows<T extends HostedWorktree>(
  rows: readonly T[],
  oldHostId: ExecutionHostId,
  newHostId: ExecutionHostId
): T[] {
  const owners = new Set(
    rows.filter((row) => row.hostId !== oldHostId).map((row) => `${row.id}\0${row.hostId ?? ''}`)
  )
  const result: T[] = []
  for (const row of rows) {
    if (row.hostId !== oldHostId) {
      result.push(row)
      continue
    }
    const key = `${row.id}\0${newHostId}`
    if (!owners.has(key)) {
      result.push({ ...row, hostId: newHostId })
      owners.add(key)
    }
  }
  return result
}

export function reconcileReadoptedSshWorktreesByRepo<T extends HostedWorktree>(
  rowsByRepo: Readonly<Record<string, readonly T[]>>,
  readoptions: readonly SshRepoReadoption[]
): Record<string, T[]> {
  let result = rowsByRepo as Record<string, T[]>
  for (const readoption of readoptions) {
    const oldHostId = toSshExecutionHostId(readoption.oldTargetId)
    const newHostId = toSshExecutionHostId(readoption.newTargetId)
    for (const repoId of readoption.repoIds) {
      const rows = result[repoId]
      if (!rows?.some((row) => row.hostId === oldHostId)) {
        continue
      }
      if (result === rowsByRepo) {
        result = { ...result }
      }
      result[repoId] = reconcileRows(rows, oldHostId, newHostId)
    }
  }
  return result
}
