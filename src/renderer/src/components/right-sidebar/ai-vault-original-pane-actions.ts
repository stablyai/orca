import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import {
  findAiVaultSessionLiveState,
  findOriginalAiVaultSessionPane
} from './ai-vault-original-pane'

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

  const getOriginalPaneTarget = useCallback(
    (session: AiVaultSession) => findOriginalAiVaultSessionPane(originalPaneLookupState, session),
    [originalPaneLookupState]
  )

  const getSessionLiveState = useCallback(
    (session: AiVaultSession) => findAiVaultSessionLiveState(originalPaneLookupState, session),
    [originalPaneLookupState]
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
