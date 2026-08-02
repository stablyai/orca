import type { AiVaultScope } from '../../../../shared/ai-vault-types'

export const DEFAULT_AI_VAULT_SCOPE: AiVaultScope = 'workspace'

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

function isAiVaultScopeAvailable(args: {
  scope: AiVaultScope
  activeProjectKey: string | null
  activeWorktreePath: string | null
}): boolean {
  return normalizeAiVaultScopeForContext(args) === args.scope
}

export function shouldRestoreDefaultAiVaultScope(args: {
  scope: AiVaultScope
  activeProjectKey: string | null
  activeWorktreePath: string | null
  userChangedScope: boolean
  defaultScope?: AiVaultScope
}): boolean {
  const defaultScope = args.defaultScope ?? DEFAULT_AI_VAULT_SCOPE

  return (
    args.scope === 'all' &&
    !args.userChangedScope &&
    isAiVaultScopeAvailable({
      scope: defaultScope,
      activeProjectKey: args.activeProjectKey,
      activeWorktreePath: args.activeWorktreePath
    })
  )
}

export function getRestorableAiVaultScope(args: {
  scope: AiVaultScope
  activeProjectKey: string | null
  activeWorktreePath: string | null
  preferredScope: AiVaultScope
  userChangedScope: boolean
  defaultScope?: AiVaultScope
}): AiVaultScope | null {
  const defaultScope = args.defaultScope ?? DEFAULT_AI_VAULT_SCOPE

  if (args.preferredScope === defaultScope) {
    return shouldRestoreDefaultAiVaultScope({
      scope: args.scope,
      activeProjectKey: args.activeProjectKey,
      activeWorktreePath: args.activeWorktreePath,
      userChangedScope: args.userChangedScope,
      defaultScope
    })
      ? defaultScope
      : null
  }

  if (args.scope !== 'all' || args.preferredScope === 'all') {
    return null
  }

  return isAiVaultScopeAvailable({
    scope: args.preferredScope,
    activeProjectKey: args.activeProjectKey,
    activeWorktreePath: args.activeWorktreePath
  })
    ? args.preferredScope
    : null
}
