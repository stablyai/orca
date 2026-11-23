import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  AiVaultAgent,
  AiVaultScope
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  consumeConversationHistoryTarget,
  type ConversationHistoryTarget
} from '@/lib/conversation-history-selection'
import type { AiVaultSessionLimit } from './ai-vault/session-list/ai-vault-session-limit'

export function useAiVaultHistoryNavigation(input: {
  onScopeChange: (scope: AiVaultScope) => void
  enabled: boolean
  setQuery: Dispatch<SetStateAction<string>>
  setSessionLimit: (limit: AiVaultSessionLimit) => void
  setAgentEnabled: (agent: AiVaultAgent, enabled: boolean) => void
  onExecutionHostScopeChange: (scope: ExecutionHostId) => void
}): {
  historyTarget: ConversationHistoryTarget | null
  onQueryChange: (query: string) => void
  clearHistoryTarget: () => void
} {
  const {
    onScopeChange,
    enabled,
    setQuery,
    setSessionLimit,
    setAgentEnabled,
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
  const clearHistoryTarget = useCallback(() => {
    if (historyTarget) {
      setHistoryTarget(null)
      setQuery('')
    }
  }, [historyTarget, setQuery])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const revealSource = (): void => {
      const target = consumeConversationHistoryTarget()
      if (!target) {
        return
      }
      setQuery(target.sessionId)
      setHistoryTarget(target)
      onScopeChange('all')
      setSessionLimit('unlimited')
      setAgentEnabled(target.agent, true)
      onExecutionHostScopeChange(target.executionHostId)
    }
    revealSource()
    window.addEventListener('orca:conversation-history-select', revealSource)
    return () => window.removeEventListener('orca:conversation-history-select', revealSource)
  }, [
    onExecutionHostScopeChange,
    onScopeChange,
    enabled,
    setAgentEnabled,
    setQuery,
    setSessionLimit
  ])
  return { historyTarget, onQueryChange, clearHistoryTarget }
}
