import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiVaultScope } from '../../../../shared/ai-vault-types'
import {
  DEFAULT_AI_VAULT_SCOPE,
  getRestorableAiVaultScope,
  normalizeAiVaultScopeForContext
} from './ai-vault-scope-state'

/**
 * The panel's scope, kept honest against the active context: an unavailable
 * Workspace or Project falls back to All, and the user's choice returns when
 * its context does.
 */
export function useAiVaultPanelScope({
  activeProjectKey,
  activeWorktreePath
}: {
  activeProjectKey: string | null
  activeWorktreePath: string | null
}): { scope: AiVaultScope; handleScopeChange: (scope: AiVaultScope) => void } {
  const [scope, setScope] = useState<AiVaultScope>(DEFAULT_AI_VAULT_SCOPE)
  const userChangedScopeRef = useRef(false)
  const preferredScopeRef = useRef<AiVaultScope>(DEFAULT_AI_VAULT_SCOPE)

  useEffect(() => {
    const normalizedScope = normalizeAiVaultScopeForContext({
      scope,
      activeProjectKey,
      activeWorktreePath
    })
    if (normalizedScope !== scope) {
      setScope(normalizedScope)
    }
  }, [activeProjectKey, activeWorktreePath, scope])

  useEffect(() => {
    const restorableScope = getRestorableAiVaultScope({
      scope,
      activeProjectKey,
      activeWorktreePath,
      preferredScope: preferredScopeRef.current,
      userChangedScope: userChangedScopeRef.current
    })
    if (restorableScope) {
      setScope(restorableScope)
    }
  }, [activeProjectKey, activeWorktreePath, scope])

  const handleScopeChange = useCallback((nextScope: AiVaultScope) => {
    preferredScopeRef.current = nextScope
    userChangedScopeRef.current = nextScope !== DEFAULT_AI_VAULT_SCOPE
    setScope(nextScope)
  }, [])

  return { scope, handleScopeChange }
}
