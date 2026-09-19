import { useCallback } from 'react'
import {
  AI_VAULT_SESSION_HOSTS,
  type AiVaultScope,
  type AiVaultSessionHost,
  type AiVaultTimeRange
} from '../../../../shared/ai-vault-types'
import { persistAiVaultSearchScope } from './ai-vault-search-scope-state'
import { DEFAULT_AI_VAULT_SCOPE } from './ai-vault-scope-state'
import type { AiVaultSearchScope } from '../../../../shared/ai-vault-session-search-scope'

export function useAiVaultPanelViewControls({
  setHosts,
  setTimeRange,
  setSearchScope,
  setScope,
  setCollapsedGroups,
  resetPersistedViewOptions,
  preferredScopeRef,
  userChangedScopeRef
}: {
  setHosts: React.Dispatch<React.SetStateAction<AiVaultSessionHost[]>>
  setTimeRange: (timeRange: AiVaultTimeRange) => void
  setSearchScope: (scope: AiVaultSearchScope) => void
  setScope: (scope: AiVaultScope) => void
  setCollapsedGroups: React.Dispatch<React.SetStateAction<Set<string>>>
  resetPersistedViewOptions: () => void
  preferredScopeRef: React.MutableRefObject<AiVaultScope>
  userChangedScopeRef: React.MutableRefObject<boolean>
}): {
  setHostEnabled: (host: AiVaultSessionHost, enabled: boolean) => void
  resetViewOptions: () => void
  handleSearchScopeChange: (nextScope: AiVaultSearchScope) => void
  handleScopeChange: (nextScope: AiVaultScope) => void
  toggleGroup: (key: string) => void
} {
  const setHostEnabled = useCallback(
    (host: AiVaultSessionHost, enabled: boolean) => {
      setHosts((current) => {
        if (enabled) {
          return current.includes(host) ? current : [...current, host]
        }
        const next = current.filter((entry) => entry !== host)
        return next.length > 0 ? next : current
      })
    },
    [setHosts]
  )

  const resetViewOptions = useCallback(() => {
    resetPersistedViewOptions()
    setTimeRange('all')
    setHosts([...AI_VAULT_SESSION_HOSTS])
  }, [resetPersistedViewOptions, setHosts, setTimeRange])

  const handleSearchScopeChange = useCallback(
    (nextScope: AiVaultSearchScope) => {
      setSearchScope(nextScope)
      persistAiVaultSearchScope(nextScope)
    },
    [setSearchScope]
  )

  const handleScopeChange = useCallback(
    (nextScope: AiVaultScope) => {
      preferredScopeRef.current = nextScope
      userChangedScopeRef.current = nextScope !== DEFAULT_AI_VAULT_SCOPE
      setScope(nextScope)
    },
    [preferredScopeRef, setScope, userChangedScopeRef]
  )

  const toggleGroup = useCallback(
    (key: string) => {
      setCollapsedGroups((current) => {
        const next = new Set(current)
        if (next.has(key)) {
          next.delete(key)
        } else {
          next.add(key)
        }
        return next
      })
    },
    [setCollapsedGroups]
  )

  return {
    setHostEnabled,
    resetViewOptions,
    handleSearchScopeChange,
    handleScopeChange,
    toggleGroup
  }
}
