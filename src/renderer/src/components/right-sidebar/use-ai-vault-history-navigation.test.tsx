// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectConversationHistoryTarget } from '@/lib/conversation-history-selection'
import { useAiVaultHistoryNavigation } from './use-ai-vault-history-navigation'

afterEach(cleanup)

describe('useAiVaultHistoryNavigation', () => {
  it.each(['all', 'project'] as const)(
    'searches the source session in the %s history scope',
    (scope) => {
      const onScopeChange = vi.fn()
      const setQuery = vi.fn()
      const setSessionLimit = vi.fn()
      const setAgentEnabled = vi.fn()
      const setCollapsedGroups = vi.fn()
      const onExecutionHostScopeChange = vi.fn()
      selectConversationHistoryTarget({
        executionHostId: 'local',
        agent: 'codex',
        sessionId: 'source-session',
        scope
      })

      const { result } = renderHook(() =>
        useAiVaultHistoryNavigation({
          onScopeChange,
          setQuery,
          setSessionLimit,
          setAgentEnabled,
          setCollapsedGroups,
          onExecutionHostScopeChange
        })
      )

      expect(setQuery).toHaveBeenCalledWith('source-session')
      expect(onScopeChange).toHaveBeenCalledWith(scope)
      expect(setSessionLimit).toHaveBeenCalledWith('unlimited')
      expect(setAgentEnabled).toHaveBeenCalledWith('codex', true)
      expect(onExecutionHostScopeChange).toHaveBeenCalledWith('local')
      expect(result.current.historyTarget).toEqual({
        executionHostId: 'local',
        agent: 'codex',
        sessionId: 'source-session',
        scope
      })
      act(() => result.current.clearHistoryTarget())
      expect(result.current.historyTarget).toBeNull()
    }
  )
})
