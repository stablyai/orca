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
>

import { useCallback } from 'react'
import { getTaskSourceRuntimeSettings } from '../../../../shared/task-source-context'

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
    sourceIntentBlocksCreate
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

  const folderCreateDisabled =
    creating ||
    sourceIntentBlocksCreate ||
    !selectedProjectGroup?.parentPath ||
    folderPathStatusBlocksCreate ||
    folderTargetRequiresConnection

  return {
    handleOpenAgentSettings,
    handleOpenJiraSettings,
    folderCreateDisabled
  }
}
