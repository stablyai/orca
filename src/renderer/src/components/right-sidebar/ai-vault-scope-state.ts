import type { AiVaultScope } from '../../../../shared/ai-vault-types'

export function normalizeAiVaultScopeForContext(args: {
  scope: AiVaultScope
  activeProjectKey: string | null
  activeWorktreePath: string | null
}): AiVaultScope {
  if (args.scope === 'project' && !args.activeProjectKey) {
    return 'all'
  }
  if (args.scope === 'workspace' && !args.activeWorktreePath) {
    return 'all'
  }
  return args.scope
}

export function shouldRestoreAiVaultProjectScope(args: {
  scope: AiVaultScope
  activeProjectKey: string | null
  userChangedScope: boolean
}): boolean {
  return Boolean(args.activeProjectKey && args.scope === 'all' && !args.userChangedScope)
}
