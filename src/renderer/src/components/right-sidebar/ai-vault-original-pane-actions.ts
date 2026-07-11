import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { findOriginalAiVaultSessionPane } from './ai-vault-original-pane'
import {
  createLazyAiVaultOriginalPaneIndex,
  findAiVaultSessionLiveStateInIndex,
  findOriginalAiVaultSessionPaneInIndex
} from './ai-vault-original-pane-index'

export function useAiVaultOriginalPaneActions(): {
  getOriginalPaneTarget: (
    session: AiVaultSession
  ) => ReturnType<typeof findOriginalAiVaultSessionPane>
  getSessionLiveState: (session: AiVaultSession) => AgentStatusState | null
  jumpToOriginalPane: (session: AiVaultSession) => void
  jumpToWorktree: (worktreeId: string) => void
} {
  const originalPaneLookupState = useAppStore(
    useShallow((s) => ({
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey: s.sleepingAgentSessionsByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      terminalLayoutsByTabId: s.terminalLayoutsByTabId
    }))
  )
  // Why: loading, filtered, or collapsed views may render no session rows.
  // Build once on the first actual lookup, then share it across visible rows.
  const getOriginalPaneIndex = useMemo(
    () => createLazyAiVaultOriginalPaneIndex(originalPaneLookupState),
    [originalPaneLookupState]
  )

  const getOriginalPaneTarget = useCallback(
    (session: AiVaultSession) =>
      findOriginalAiVaultSessionPaneInIndex(getOriginalPaneIndex(), session),
    [getOriginalPaneIndex]
  )

  const getSessionLiveState = useCallback(
    (session: AiVaultSession) =>
      findAiVaultSessionLiveStateInIndex(getOriginalPaneIndex(), session),
    [getOriginalPaneIndex]
  )

  const jumpToOriginalPane = useCallback((session: AiVaultSession): void => {
    const target = findOriginalAiVaultSessionPane(useAppStore.getState(), session)
    if (!target) {
      toast.error(
        translate(
          'auto.components.right.sidebar.AiVaultPanel.originalPaneUnavailable',
          'Original pane is no longer available.'
        )
      )
      return
    }

    if (!activateAndRevealWorktree(target.worktreeId)) {
      toast.error(
        translate(
          'auto.components.right.sidebar.AiVaultPanel.worktreeUnavailable',
          'Worktree is no longer available.'
        )
      )
      return
    }
    const state = useAppStore.getState()
    state.setActiveTabType('terminal')
    activateTabAndFocusPane(target.tabId, target.leafId, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }, [])

  const jumpToWorktree = useCallback((worktreeId: string): void => {
    if (!activateAndRevealWorktree(worktreeId)) {
      toast.error(
        translate(
          'auto.components.right.sidebar.AiVaultPanel.worktreeUnavailable',
          'Worktree is no longer available.'
        )
      )
    }
  }, [])

  return { getOriginalPaneTarget, getSessionLiveState, jumpToOriginalPane, jumpToWorktree }
}
