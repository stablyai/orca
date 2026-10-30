import { useMemo, useState } from 'react'
import type React from 'react'
import type { Repo } from '../../../../../../shared/repo-types'
import { normalizeSourceControlAiSettings } from '../../../../../../shared/source-control-ai-settings'
import type { SourceControlAiRepoUpdate } from '../../../../../../shared/source-control-ai-recipe-save'
import { useAppStore } from '../../../../store/index'
import { getRepositorySourceControlAiSectionId } from '../repository-settings-targets'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { RepositorySourceControlAiCustomCommand } from './RepositorySourceControlAiCustomCommand'
import { RepositorySourceControlAiEnablement } from './RepositorySourceControlAiEnablement'
import { RepositorySourceControlAiHostedReviewDefaults } from './RepositorySourceControlAiHostedReviewDefaults'
import { normalizeRepoAiDraft } from './repository-source-control-ai-draft'
import { useRepositorySourceControlAiGlobalUx } from './repository-source-control-ai-global-ux'
import { getSettingOwnershipSummary } from '../../setting-ownership'
import { translate } from '@/i18n/i18n'

type RepositorySourceControlAiSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: SourceControlAiRepoUpdate) => void | Promise<boolean>
}

export function useRepositorySourceControlAiSession({
  repo,
  repoId,
  updateRepo
}: {
  repo: Repo | undefined
  repoId: string
  updateRepo: RepositorySourceControlAiSectionProps['updateRepo']
}) {
  const settings = useAppStore((state) => state.settings)
  const source = normalizeSourceControlAiSettings(
    settings?.sourceControlAi,
    settings?.commitMessageAi
  )
  const hasCurrentRepo = repo !== undefined
  const publishedRepoAi = repo?.sourceControlAi
  const persistedRepoAi = useMemo(
    () => (hasCurrentRepo ? normalizeRepoAiDraft(publishedRepoAi) : null),
    [publishedRepoAi, hasCurrentRepo]
  )
  const controller = useRepositorySourceControlAiGlobalUx({
    repoId,
    persistedRepoAi,
    settings,
    source,
    updateRepo
  })

  const [forceRepoMode, setForceRepoMode] = useState(false)
  return { ...controller, source, settings, forceRepoMode, setForceRepoMode }
}

type AiSession = ReturnType<typeof useRepositorySourceControlAiSession>
export function RepositorySourceControlAiSection(
  props: RepositorySourceControlAiSectionProps & { controller?: AiSession }
): React.JSX.Element {
  return props.controller ? (
    <RepositorySourceControlAiView {...props} controller={props.controller} />
  ) : (
    <LocalRepositorySourceControlAi {...props} />
  )
}
function LocalRepositorySourceControlAi(
  props: RepositorySourceControlAiSectionProps
): React.JSX.Element {
  const controller = useRepositorySourceControlAiSession({ ...props, repoId: props.repo.id })
  return <RepositorySourceControlAiView {...props} controller={controller} />
}
function RepositorySourceControlAiView({
  repo,
  controller
}: RepositorySourceControlAiSectionProps & { controller: AiSession }): React.JSX.Element {
  const ownership = getSettingOwnershipSummary('repositorySourceControlAi')
  const {
    displayRepoAi,
    source,
    settings,
    saveError,
    actionDirtyById,
    savingActionIds,
    updateEnablement,
    updateCustomCommand,
    updateHostedReviewDefault,
    updateActionMode,
    updateActionAgent,
    updateActionLaunchPreferences,
    updateActionTemplate,
    updateActionAgentArgs,
    appendVariable,
    saveActionRecipeText,
    discardActionRecipeText,
    commitCustomCommand
  } = controller
  return (
    <section
      id={getRepositorySourceControlAiSectionId(repo.id)}
      data-settings-section={getRepositorySourceControlAiSectionId(repo.id)}
      className="space-y-4"
    >
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.RepositorySourceControlAiSection.71b003b62b',
            'Source Control AI'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">{ownership.description}</p>
        {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}
      </div>

      <RepositorySourceControlAiEnablement
        value={displayRepoAi.enabled}
        source={source}
        onChange={updateEnablement}
      />
      <RepositorySourceControlAiCustomCommand
        modeIntent={controller}
        value={displayRepoAi.customAgentCommand}
        source={source}
        onChange={updateCustomCommand}
        onCommit={commitCustomCommand}
      />
      <RepositorySourceControlAiActionRows
        repo={repo}
        repoId={repo.id}
        repoAi={displayRepoAi}
        source={source}
        defaultTuiAgent={settings?.defaultTuiAgent}
        savingActionIds={savingActionIds}
        actionDirtyById={actionDirtyById}
        onActionModeChange={updateActionMode}
        onActionAgentChange={updateActionAgent}
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
    </section>
  )
}
