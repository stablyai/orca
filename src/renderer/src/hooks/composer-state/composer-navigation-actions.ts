import type { ComposerModel } from './composer-model'

type ComposerNavigationActionsInput = Pick<
  ComposerModel,
  | 'closeModal'
  | 'creating'
  | 'folderPathStatusBlocksCreate'
  | 'folderTargetRequiresConnection'
  | 'openSettingsPage'
  | 'openSettingsTarget'
  | 'selectedProjectGroup'
  | 'setActiveRuntimeEnvironmentPreference'
  | 'smartNameJiraSourceContext'
  | 'sourceIntentBlocksCreate'
  | 'updateWorktreeMeta'
>

import { useCallback } from 'react'
import { getTaskSourceRuntimeSettings } from '../../../../shared/task-source-context'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

export function useComposerNavigationActions(input: ComposerNavigationActionsInput) {
  const {
    closeModal,
    creating,
    folderPathStatusBlocksCreate,
    folderTargetRequiresConnection,
    openSettingsPage,
    openSettingsTarget,
    selectedProjectGroup,
    setActiveRuntimeEnvironmentPreference,
    smartNameJiraSourceContext,
    sourceIntentBlocksCreate,
    updateWorktreeMeta
  } = input

  const handleOpenAgentSettings = useCallback((): void => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
    closeModal()
  }, [closeModal, openSettingsPage, openSettingsTarget])

  const handleOpenJiraSettings = useCallback((): void => {
    const runtimeEnvironmentId = getTaskSourceRuntimeSettings(
      smartNameJiraSourceContext
    ).activeRuntimeEnvironmentId
    const targetRuntimeEnvironmentId = runtimeEnvironmentId ?? null
    void setActiveRuntimeEnvironmentPreference(targetRuntimeEnvironmentId).then((selected) => {
      if (!selected) {
        return
      }
      openSettingsTarget({ pane: 'integrations', repoId: null })
      openSettingsPage()
      closeModal()
    })
  }, [
    closeModal,
    openSettingsPage,
    openSettingsTarget,
    setActiveRuntimeEnvironmentPreference,
    smartNameJiraSourceContext
  ])

  const applyWorktreeMeta = useCallback(
    async (worktreeId: string, meta: Partial<WorktreeMeta>): Promise<void> => {
      if (Object.keys(meta).length === 0) {
        return
      }
      try {
        await updateWorktreeMeta(worktreeId, meta)
      } catch {
        console.error('Failed to update worktree meta after creation')
      }
    },
    [updateWorktreeMeta]
  )

  const folderCreateDisabled =
    creating ||
    sourceIntentBlocksCreate ||
    !selectedProjectGroup?.parentPath ||
    folderPathStatusBlocksCreate ||
    folderTargetRequiresConnection

  return {
    handleOpenAgentSettings,
    handleOpenJiraSettings,
    applyWorktreeMeta,
    folderCreateDisabled
  }
}
