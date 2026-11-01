import { normalizeAiVaultScopeForContext } from './ai-vault-scope-state'
import { useAiVaultPanelTransientState } from './ai-vault-panel-transient-state'

export function useAiVaultPanelScope({
  activeProjectKey,
  activeWorktreePath,
  local = false
}: {
  activeProjectKey: string | null
  activeWorktreePath: string | null
  local?: boolean
}) {
  const state = useAiVaultPanelTransientState(local)
  return {
    ...state,
    scope: normalizeAiVaultScopeForContext({
      scope: state.preferredScope,
      activeProjectKey,
      activeWorktreePath
    }),
    handleScopeChange: state.selectScope
  }
}
