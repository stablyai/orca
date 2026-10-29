import type { WorktreeOperationOwnerRecord } from './worktree-operation-route'

type WorktreeOwnerRows = Record<string, readonly WorktreeOperationOwnerRecord[]>

const ownerRowTokens = new WeakMap<WorktreeOwnerRows, object>()
let lastOwnerRows: { signature: string; token: object } | null = null

function ownerRowsSignature(worktreesByRepo: WorktreeOwnerRows): string {
  return JSON.stringify(
    Object.entries(worktreesByRepo).map(([bucket, rows]) => [
      bucket,
      rows.map((row) => {
        // Every owner field, so a new one cannot be silently left out of the signature.
        const owner: { [K in keyof Required<WorktreeOperationOwnerRecord>]: unknown } = {
          id: row.id,
          repoId: row.repoId,
          hostId: row.hostId ?? null,
          runtimeOwnerEnvironmentId: row.runtimeOwnerEnvironmentId ?? null
        }
        return Object.values(owner)
      })
    ])
  )
}

/** Equal tokens mean equal row ownership; rank/unread/activity patches keep the token, so owner consumers can skip them. */
export function worktreeOwnerRowsTokenOf(worktreesByRepo: WorktreeOwnerRows | undefined): unknown {
  if (!worktreesByRepo) {
    return worktreesByRepo
  }
  let token = ownerRowTokens.get(worktreesByRepo)
  if (!token) {
    const signature = ownerRowsSignature(worktreesByRepo)
    token = lastOwnerRows?.signature === signature ? lastOwnerRows.token : {}
    lastOwnerRows = { signature, token }
    ownerRowTokens.set(worktreesByRepo, token)
  }
  return token
}
