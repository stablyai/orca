import { normalizeAiVaultScopeForContext } from './ai-vault-scope-state'
import { useAiVaultPanelTransientState } from './ai-vault-panel-transient-state'
import { usePersistedAiVaultGroupCollapse } from './use-persisted-ai-vault-view-options'

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
  const persisted = usePersistedAiVaultGroupCollapse()
  return {
    ...state,
    ...(!local && persisted),
    scope: normalizeAiVaultScopeForContext({
      scope: state.preferredScope,
      activeProjectKey,
      activeWorktreePath
    }),
    handleScopeChange: state.selectScope
  }
}
