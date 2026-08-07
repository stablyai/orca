import { AI_VAULT_SCOPE_PATHS_MAX_COUNT } from '../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AiVaultTitleRequest } from './ai-vault-tab-title-requests'

export function groupAiVaultTitleRequests(
  requests: AiVaultTitleRequest[]
): AiVaultTitleRequest[][] {
  const byHost = new Map<ExecutionHostId, Map<string | null, AiVaultTitleRequest[]>>()
  for (const request of requests) {
    const byPath = byHost.get(request.executionHostId) ?? new Map()
    const pathRequests = byPath.get(request.scopePath)
    if (pathRequests) {
      pathRequests.push(request)
    } else {
      byPath.set(request.scopePath, [request])
    }
    byHost.set(request.executionHostId, byPath)
  }

  const groups: AiVaultTitleRequest[][] = []
  for (const byPath of byHost.values()) {
    const unscoped = byPath.get(null) ?? []
    const scoped = [...byPath].filter(
      (entry): entry is [string, AiVaultTitleRequest[]] => entry[0] !== null
    )
    if (scoped.length === 0) {
      if (unscoped.length > 0) {
        groups.push(unscoped)
      }
      continue
    }
    for (let index = 0; index < scoped.length; index += AI_VAULT_SCOPE_PATHS_MAX_COUNT) {
      groups.push([
        ...(index === 0 ? unscoped : []),
        ...scoped
          .slice(index, index + AI_VAULT_SCOPE_PATHS_MAX_COUNT)
          .flatMap(([, pathRequests]) => pathRequests)
      ])
    }
  }
  return groups
}
