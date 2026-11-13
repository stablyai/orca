import { useShallow } from 'zustand/react/shallow'
import { useMemo } from 'react'
import type React from 'react'
import type { Repo } from '../../../../../../shared/repo-types'
import { normalizeSourceControlAiSettings } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import type { SourceControlAiRepoUpdate } from '../../../../../../shared/source-control/ai/settings/source-control-ai-recipe-save'
import type { SourceControlAiSettingsPatch } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { useAppStore } from '../../../../store/index'
import {
  getRepositorySourceControlAiSectionId,
  REPOSITORY_SOURCE_CONTROL_AI_CARD_ID
} from '../repository-settings-targets'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { RepositorySourceControlAiCustomCommand } from './RepositorySourceControlAiCustomCommand'
import { RepositorySourceControlAiEnablement } from './RepositorySourceControlAiEnablement'
import { RepositorySourceControlAiHostedReviewDefaults } from './RepositorySourceControlAiHostedReviewDefaults'
import { normalizeRepoAiDraft } from './repository-source-control-ai-draft'
import { useRepositorySourceControlAiGlobalUx } from './repository-source-control-ai-global-ux'
import { getSettingOwnershipSummary } from '../../page/setting-ownership'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

type RepositorySourceControlAiSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: SourceControlAiRepoUpdate) => void | Promise<boolean>
  /** Lets the text pickers save model lists the repository's host reports. */
  writeSourceControlAiSettings?: (patch: SourceControlAiSettingsPatch) => Promise<void>
}

/** Persist simple controls immediately; draft CLI args/templates until per-action Save, matching global recipes. */
export function RepositorySourceControlAiSection({
  repo,
  updateRepo,
  writeSourceControlAiSettings
}: RepositorySourceControlAiSectionProps): React.JSX.Element {
  const t = useTranslate()
  const settings = useAppStore(
    useShallow(
      (state) =>
        state.settings && {
          sourceControlAi: state.settings.sourceControlAi,
          commitMessageAi: state.settings.commitMessageAi,
          defaultTuiAgent: state.settings.defaultTuiAgent
        }
    )
  )
  const ownership = getSettingOwnershipSummary('repositorySourceControlAi', t)
  const source = useMemo(
    () => normalizeSourceControlAiSettings(settings?.sourceControlAi, settings?.commitMessageAi),
    [settings?.sourceControlAi, settings?.commitMessageAi]
  )
  const persistedRepoAi = useMemo(
    () => normalizeRepoAiDraft(repo.sourceControlAi),
    [repo.sourceControlAi]
  )
  const {
    displayRepoAi,
    actionTextDrafts,
    saveError,
    actionDirtyById,
    savingActionIds,
    updateEnablement,
    updateCustomCommand,
    updateHostedReviewDefault,
    updateActionMode,
    updateActionAgent,
    updateActionTextModelChoice,
    updateActionLaunchPreferences,
    updateActionTemplate,
    updateActionAgentArgs,
    appendVariable,
    saveActionRecipeText,
    discardActionRecipeText,
    commitCustomCommand
  } = useRepositorySourceControlAiGlobalUx({
    repoId: repo.id,
    persistedRepoAi,
    settings,
    source,
    updateRepo
  })

  return (
    <div
      id={getRepositorySourceControlAiSectionId(repo.id)}
      data-settings-section={getRepositorySourceControlAiSectionId(repo.id)}
    >
      <SettingsGroup
        id={REPOSITORY_SOURCE_CONTROL_AI_CARD_ID}
        title={t(
          'auto.components.settings.RepositorySourceControlAiSection.112f3b934f',
          'Source control AI'
        )}
        description={
          <>
            {ownership.description}
            {saveError ? <span className="block text-destructive">{saveError}</span> : null}
          </>
        }
      >
        <RepositorySourceControlAiEnablement
          value={displayRepoAi.enabled}
          source={source}
          onChange={updateEnablement}
        />
        <RepositorySourceControlAiCustomCommand
          value={displayRepoAi.customAgentCommand}
          source={source}
          onChange={updateCustomCommand}
          onCommit={commitCustomCommand}
        />
        <RepositorySourceControlAiActionRows
          repoId={repo.id}
          repoAi={displayRepoAi}
          actionTextDrafts={actionTextDrafts}
          source={source}
          defaultTuiAgent={settings?.defaultTuiAgent}
          savingActionIds={savingActionIds}
          actionDirtyById={actionDirtyById}
          onActionModeChange={updateActionMode}
          onActionAgentChange={updateActionAgent}
          onActionTextModelChoice={updateActionTextModelChoice}
          writeSourceControlAiSettings={writeSourceControlAiSettings}
          onActionLaunchPreferencesChange={updateActionLaunchPreferences}
          onActionTemplateChange={updateActionTemplate}
          onActionAgentArgsChange={updateActionAgentArgs}
          onAppendVariable={appendVariable}
          onActionDiscard={discardActionRecipeText}
          onActionSave={(actionId) => void saveActionRecipeText(actionId)}
        />
        <RepositorySourceControlAiHostedReviewDefaults
          value={displayRepoAi.prCreationDefaults}
          source={source}
          onChange={updateHostedReviewDefault}
        />
      </SettingsGroup>
    </div>
  )
}
