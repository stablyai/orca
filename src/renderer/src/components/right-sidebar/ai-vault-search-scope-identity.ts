import type { AiVaultSearchScopeIdentity } from '../../../../shared/ai-vault-search-scope'
import type { AiVaultScope } from '../../../../shared/ai-vault-types'

// `all` sends nothing, which still means every session the host has.
export function aiVaultSearchScopeIdentity(args: {
  scope: AiVaultScope
  activeWorktreeId: string | null | undefined
  activeProjectKey: string | null
}): AiVaultSearchScopeIdentity | undefined {
  if (args.scope === 'workspace' && args.activeWorktreeId) {
    return { kind: 'workspace', worktreeId: args.activeWorktreeId }
  }
  if (args.scope === 'project' && args.activeProjectKey) {
    return { kind: 'project', projectKey: args.activeProjectKey }
  }
  return undefined
}
