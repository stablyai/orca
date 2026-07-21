import { useMemo } from 'react'
import type React from 'react'
import type { Repo } from '../../../../shared/types'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'
import type { SourceControlAiRepoUpdate } from '../../../../shared/source-control-ai-recipe-save'
import { useAppStore } from '../../store'
import { getRepositorySourceControlAiSectionId } from './repository-settings-targets'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { RepositorySourceControlAiCustomCommand } from './RepositorySourceControlAiCustomCommand'
import { RepositorySourceControlAiEnablement } from './RepositorySourceControlAiEnablement'
import { RepositorySourceControlAiHostedReviewDefaults } from './RepositorySourceControlAiHostedReviewDefaults'
import {
  normalizePersistedRepoAi,
  useRepositorySourceControlAiGlobalUx
} from './repository-source-control-ai-global-ux'
import { getSettingOwnershipSummary } from './setting-ownership'
import { translate } from '@/i18n/i18n'

type RepositorySourceControlAiSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: SourceControlAiRepoUpdate) => void | Promise<boolean>
}

/**
 * Per-repo Source Control AI settings — save UX matches global Git / Source Control AI:
 * selects and simple controls persist immediately; each action recipe drafts CLI args +
 * command template until that row's Save (same as global action recipes).
 */
export function RepositorySourceControlAiSection({
  repo,
  updateRepo
}: RepositorySourceControlAiSectionProps): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const ownership = getSettingOwnershipSummary('repositorySourceControlAi')
  const source = normalizeSourceControlAiSettings(
    settings?.sourceControlAi,
    settings?.commitMessageAi
  )
  const persistedRepoAi = useMemo(
    () => normalizePersistedRepoAi(repo.sourceControlAi),
    [repo.sourceControlAi]
  )
  const {
    displayRepoAi,
    saveError,
    actionDirtyById,
    savingActionIds,
    updateEnablement,
    updateCustomCommand,
    updateHostedReviewDefault,
    updateActionMode,
    updateActionAgent,
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
        value={displayRepoAi.customAgentCommand}
        source={source}
        onChange={updateCustomCommand}
        onCommit={commitCustomCommand}
      />
      <RepositorySourceControlAiActionRows
        repoId={repo.id}
        repoAi={displayRepoAi}
        source={source}
        defaultTuiAgent={settings?.defaultTuiAgent}
        savingActionIds={savingActionIds}
        actionDirtyById={actionDirtyById}
        onActionModeChange={updateActionMode}
        onActionAgentChange={updateActionAgent}
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
