import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { AiVaultAgent, AiVaultScope } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { consumeConversationHistoryTarget } from '@/lib/conversation-history-selection'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

export function useAiVaultHistoryNavigation(input: {
  onScopeChange: (scope: AiVaultScope) => void
  setQuery: Dispatch<SetStateAction<string>>
  setSessionLimit: (limit: AiVaultSessionLimit) => void
  setAgentEnabled: (agent: AiVaultAgent, enabled: boolean) => void
  setCollapsedGroups: Dispatch<SetStateAction<Set<string>>>
  onExecutionHostScopeChange: (scope: ExecutionHostId) => void
}): void {
  const {
    onScopeChange,
    setQuery,
    setSessionLimit,
    setAgentEnabled,
    setCollapsedGroups,
    onExecutionHostScopeChange
  } = input

  useEffect(() => {
    const revealSource = (): void => {
      const target = consumeConversationHistoryTarget()
      if (!target) {
        return
      }
      setQuery(target.sessionId)
      onScopeChange(target.scope)
      setSessionLimit('unlimited')
      setAgentEnabled(target.agent, true)
      setCollapsedGroups(new Set())
      onExecutionHostScopeChange(target.executionHostId)
    }
    revealSource()
    window.addEventListener('orca:conversation-history-select', revealSource)
    return () => window.removeEventListener('orca:conversation-history-select', revealSource)
  }, [
    onExecutionHostScopeChange,
    onScopeChange,
    setAgentEnabled,
    setCollapsedGroups,
    setQuery,
    setSessionLimit
  ])
}
