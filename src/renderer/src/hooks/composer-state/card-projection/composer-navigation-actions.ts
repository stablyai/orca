import type { ComposerModel } from '../composer-model'

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
  | 'smartNameClickUpSourceContext'
  | 'sourceIntentBlocksCreate'
>

import { useCallback } from 'react'
import { getTaskSourceRuntimeSettings } from '../../../../../shared/work-items/task-source-context'

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
    smartNameClickUpSourceContext,
    sourceIntentBlocksCreate
  } = input

  const handleOpenAgentSettings = useCallback((): void => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
    closeModal()
  }, [closeModal, openSettingsPage, openSettingsTarget])

  // Why: the integration lives on the host that owns the source, so Settings must target that host first.
  const openIntegrationSettings = useCallback(
    (sourceContext: ComposerNavigationActionsInput['smartNameJiraSourceContext']): void => {
      const runtimeEnvironmentId =
        getTaskSourceRuntimeSettings(sourceContext).activeRuntimeEnvironmentId
      const targetRuntimeEnvironmentId = runtimeEnvironmentId ?? null
      void setActiveRuntimeEnvironmentPreference(targetRuntimeEnvironmentId).then((selected) => {
        if (!selected) {
          return
        }
        openSettingsTarget({ pane: 'integrations', repoId: null })
        openSettingsPage()
        closeModal()
      })
    },
    [closeModal, openSettingsPage, openSettingsTarget, setActiveRuntimeEnvironmentPreference]
  )
  const handleOpenJiraSettings = useCallback(
    (): void => openIntegrationSettings(smartNameJiraSourceContext),
    [openIntegrationSettings, smartNameJiraSourceContext]
  )
  const handleOpenClickUpSettings = useCallback(
    (): void => openIntegrationSettings(smartNameClickUpSourceContext),
    [openIntegrationSettings, smartNameClickUpSourceContext]
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
    handleOpenClickUpSettings,
    folderCreateDisabled
  }
}
