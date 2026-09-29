import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { AiVaultAgent, AiVaultScope } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  consumeConversationHistoryTarget,
  type ConversationHistoryTarget
} from '@/lib/conversation-history-selection'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

export function useAiVaultHistoryNavigation(input: {
  onScopeChange: (scope: AiVaultScope) => void
  setQuery: Dispatch<SetStateAction<string>>
  setSessionLimit: (limit: AiVaultSessionLimit) => void
  setAgentEnabled: (agent: AiVaultAgent, enabled: boolean) => void
  setCollapsedGroups: Dispatch<SetStateAction<Set<string>>>
  onExecutionHostScopeChange: (scope: ExecutionHostId) => void
}): {
  historyTarget: ConversationHistoryTarget | null
  onQueryChange: (query: string) => void
  clearHistoryTarget: () => void
} {
  const {
    onScopeChange,
    setQuery,
    setSessionLimit,
    setAgentEnabled,
    setCollapsedGroups,
    onExecutionHostScopeChange
  } = input
  const [historyTarget, setHistoryTarget] = useState<ConversationHistoryTarget | null>(null)
  const onQueryChange = useCallback(
    (query: string) => {
      setHistoryTarget(null)
      setQuery(query)
    },
    [setQuery]
  )
  const clearHistoryTarget = useCallback(() => setHistoryTarget(null), [])

  useEffect(() => {
    const revealSource = (): void => {
      const target = consumeConversationHistoryTarget()
      if (!target) {
        return
      }
      setQuery(target.sessionId)
      setHistoryTarget(target)
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
  return { historyTarget, onQueryChange, clearHistoryTarget }
}
