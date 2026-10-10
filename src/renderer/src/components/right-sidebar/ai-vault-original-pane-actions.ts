import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { useAppStore } from '@/store'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { findStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
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
  isStructuredSessionOpen: (session: AiVaultSession) => boolean
  jumpToOriginalPane: (session: AiVaultSession) => void
  jumpToWorktree: (worktreeId: string) => void
} {
  const originalPaneLookupState = useAppStore(
    useShallow((s) => ({
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey: s.sleepingAgentSessionsByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      terminalLayoutsByTabId: s.terminalLayoutsByTabId,
      unifiedTabsByWorktree: s.unifiedTabsByWorktree
    }))
  )

  const isStructuredSessionOpen = useCallback(
    (session: AiVaultSession): boolean => {
      const structured = session.structuredSession
      return structured
        ? Boolean(
            findStructuredAgentSessionTab(originalPaneLookupState.unifiedTabsByWorktree, {
              workspaceId: structured.workspaceId,
              sessionId: structured.sessionId
            })
          )
        : false
    },
    [originalPaneLookupState.unifiedTabsByWorktree]
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

  const jumpToOriginalPane = useCallback(
    (session: AiVaultSession): void => {
      if (session.structuredSession && isStructuredSessionOpen(session)) {
        void activateAiVaultStructuredSession(session)
        return
      }
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

      if (!revealSessionWorkspace(target.worktreeId)) {
        return
      }
      const state = useAppStore.getState()
      state.setActiveTabType('terminal', target.worktreeId)
      activateTabAndFocusPane(target.tabId, target.leafId, {
        flashFocusedPane: true,
        scrollToBottomIfOutputSinceLastView: true
      })
    },
    [isStructuredSessionOpen]
  )

  const jumpToWorktree = useCallback((worktreeId: string): void => {
    revealSessionWorkspace(worktreeId)
  }, [])

  return {
    getOriginalPaneTarget,
    getSessionLiveState,
    isStructuredSessionOpen,
    jumpToOriginalPane,
    jumpToWorktree
  }
}

function revealSessionWorkspace(workspaceId: string): boolean {
  if (activateAndRevealWorkspace(workspaceId) !== false) {
    return true
  }
  // Folder activation explains a refusal itself once it resolves the folder; anything else is gone.
  const scope = parseWorkspaceKey(workspaceId)
  const reported =
    scope?.type === 'folder' &&
    findFolderWorkspaceOwner(useAppStore.getState(), scope.folderWorkspaceId) !== null
  if (!reported) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.worktreeUnavailable',
        'Worktree is no longer available.'
      )
    )
  }
  return false
}
