import { AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT } from '../../../shared/ai-vault-session-title'
import type { ExecutionHostId } from '../../../shared/execution-host'

export function batchAiVaultTitleRequests<T extends { executionHostId: ExecutionHostId }>(
  requests: T[]
): T[][] {
  const byHost = new Map<ExecutionHostId, T[]>()
  for (const request of requests) {
    const hostRequests = byHost.get(request.executionHostId)
    if (hostRequests) {
      hostRequests.push(request)
    } else {
      byHost.set(request.executionHostId, [request])
    }
  }
  const batches: T[][] = []
  for (const hostRequests of byHost.values()) {
    for (
      let index = 0;
      index < hostRequests.length;
      index += AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT
    ) {
      batches.push(hostRequests.slice(index, index + AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT))
    }
  }
  return batches
}

export async function settleAiVaultTitleRequestBatches<
  T extends { executionHostId: ExecutionHostId }
>(requests: T[], resolveBatch: (batch: T[]) => Promise<void>): Promise<void> {
  const batchesByHost = new Map<ExecutionHostId, T[][]>()
  for (const batch of batchAiVaultTitleRequests(requests)) {
    const executionHostId = batch[0]!.executionHostId
    const hostBatches = batchesByHost.get(executionHostId) ?? []
    hostBatches.push(batch)
    batchesByHost.set(executionHostId, hostBatches)
  }
  await Promise.all(
    [...batchesByHost.values()].map(async (hostBatches) => {
      for (const batch of hostBatches) {
        try {
          await resolveBatch(batch)
        } catch {
          // One unavailable host/batch must not suppress later exact identities.
        }
      }
    })
  )
}
