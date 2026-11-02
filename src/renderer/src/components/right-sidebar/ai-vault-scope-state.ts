import type { AiVaultScope } from '../../../../shared/ai-vault-types'

export const DEFAULT_AI_VAULT_SCOPE: AiVaultScope = 'workspace'

const AI_VAULT_SCOPES_IN_ORDER: readonly AiVaultScope[] = ['workspace', 'project', 'all']

/** Fired by the scope shortcuts; the mounted Agents panel steps its scope by the detail. */
export const AI_VAULT_SCOPE_STEP_EVENT = 'orca:ai-vault-scope-step'

/** Next scope in tab order, wrapping, skipping scopes the current context cannot show. */
export function stepAiVaultScope(args: {
  scope: AiVaultScope
  step: 1 | -1
  workspaceAvailable: boolean
  projectAvailable: boolean
}): AiVaultScope {
  const available = AI_VAULT_SCOPES_IN_ORDER.filter(
    (scope) =>
      scope === 'all' || (scope === 'workspace' ? args.workspaceAvailable : args.projectAvailable)
  )
  const index = available.indexOf(args.scope)
  return available[(index + args.step + available.length) % available.length]
}

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
