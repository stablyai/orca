import { useMemo } from 'react'
import type React from 'react'
import { toast } from 'sonner'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../shared/source-control-ai-types'
import { CUSTOM_AGENT_ID } from '../../../../shared/commit-message-agent-spec'
import type { CustomAgentId } from '../../../../shared/commit-message-agent-spec'
import {
  SOURCE_CONTROL_ACTION_IDS,
  setSourceControlActionDefault,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import { Label } from '../ui/label'
import { useAppStore } from '@/store'
import { useRepos } from '@/store/selectors'
import {
  summarizeReposOverridingActionRecipe,
  type SourceControlActionRecipeOverrideSummary
} from '@/lib/source-control-launch-agent-selection'
import { SearchableSetting } from './SearchableSetting'
import { getRepositorySourceControlAiActionRecipeSectionId } from './repository-settings-targets'
import { matchesSettingsSearch } from './settings-search'
import { SourceControlActionRecipeRow } from './SourceControlActionRecipeRow'
import { SourceControlActionRepoOverrideNote } from './SourceControlActionRepoOverrideNote'
import { useSourceControlActionRecipeDraftState } from './source-control-action-recipe-draft-state'
import { translate } from '@/i18n/i18n'

type SourceControlAiActionRecipeDefaultsProps = {
  config: SourceControlAiSettings
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
  customPromptDiscardSignal?: number
  onCustomPromptDirtyChange?: (dirty: boolean) => void
  searchQuery: string
  writeConfig: (patch: SourceControlAiSettingsPatch) => Promise<void>
}

const ACTION_RECIPES_SEARCH_ENTRY = {
  get title() {
    return translate(
      'auto.components.settings.SourceControlAiActionRecipeDefaults.a79c567194',
      'Action recipes'
    )
  },
  get description() {
    return translate(
      'auto.components.settings.SourceControlAiActionRecipeDefaults.cf01d41bce',
      'Agent, CLI arguments, and command template used by each Source Control AI button.'
    )
  },
  get keywords() {
    return [
      translate('auto.components.settings.SourceControlAiActionRecipeDefaults.926d58e87f', 'agent'),
      translate(
        'auto.components.settings.SourceControlAiActionRecipeDefaults.db9bd75d10',
        'arguments'
      ),
      translate('auto.components.settings.SourceControlAiActionRecipeDefaults.2576299196', 'args'),
      translate('auto.components.settings.SourceControlAiActionRecipeDefaults.673369fe0c', 'cli'),
      translate(
        'auto.components.settings.SourceControlAiActionRecipeDefaults.d74fdc776c',
        'command'
      ),
      translate('auto.components.settings.SourceControlAiActionRecipeDefaults.eb7e8f3b39', 'model'),
      translate(
        'auto.components.settings.SourceControlAiActionRecipeDefaults.2037c78a6f',
        'template'
      ),
      translate('auto.components.settings.SourceControlAiActionRecipeDefaults.cb67b938c5', 'fix'),
      translate(
        'auto.components.settings.SourceControlAiActionRecipeDefaults.06a9dab64d',
        'checks'
      ),
      translate(
        'auto.components.settings.SourceControlAiActionRecipeDefaults.e5b24893ba',
        'commit'
      ),
      translate(
        'auto.components.settings.SourceControlAiActionRecipeDefaults.7ab1437a12',
        'pull request'
      )
    ]
  }
}

export function SourceControlAiActionRecipeDefaults({
  config,
  defaultTuiAgent,
  customPromptDiscardSignal,
  onCustomPromptDirtyChange,
  searchQuery,
  writeConfig
}: SourceControlAiActionRecipeDefaultsProps): React.JSX.Element | null {
  const allRepos = useRepos()
  // Recomputes on every keystroke in the sibling recipe textareas otherwise, so
  // memoize the filter and the O(actions × repos) override scan on `repos`.
  const repos = useMemo(() => allRepos.filter((repo) => !isFolderRepo(repo)), [allRepos])
  const overrideSummaries = useMemo(
    () =>
      Object.fromEntries(
        SOURCE_CONTROL_ACTION_IDS.map((actionId) => [
          actionId,
          summarizeReposOverridingActionRecipe({ repos, actionId })
        ])
      ) as Record<SourceControlActionId, SourceControlActionRecipeOverrideSummary>,
    [repos]
  )
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const {
    actionRecipeDraftState,
    savingActionTemplateIds,
    onActionTemplateChange,
    onActionAgentArgsChange,
    saveActionTemplateDraft,
    discardActionTemplateDraft,
    appendVariable
  } = useSourceControlActionRecipeDraftState({
    config,
    customPromptDiscardSignal,
    onCustomPromptDirtyChange,
    writeConfig
  })

  const onActionAgentChange = async (
    actionId: SourceControlActionId,
    value: string
  ): Promise<void> => {
    const agentId =
      value === '__default_agent__'
        ? null
        : value === CUSTOM_AGENT_ID
          ? CUSTOM_AGENT_ID
          : (value as TuiAgent)
    let previousActions = config.actions
    try {
      await writeConfig((current) => {
        previousActions = current.actions
        return {
          actions: setSourceControlActionDefault(current.actions, actionId, { agentId })
        }
      })
    } catch (error) {
      console.error('Failed to save Source Control AI action agent default', error)
      try {
        await writeConfig({ actions: previousActions })
      } catch (rollbackError) {
        console.error('Failed to roll back Source Control AI action agent default', rollbackError)
      }
      toast.error(
        translate(
          'auto.components.settings.SourceControlAiActionRecipeDefaults.b5f46664d3',
          'Failed to save Source Control AI action default: {{value0}}',
          { value0: error instanceof Error ? error.message : 'Unknown error' }
        )
      )
    }
  }

  const openRepoSourceControlAiSettings = (
    repoId: string,
    actionId: SourceControlActionId
  ): void => {
    openSettingsTarget({
      pane: 'repo',
      repoId,
      sectionId: getRepositorySourceControlAiActionRecipeSectionId(repoId, actionId)
    })
    openSettingsPage()
  }

  if (!config.enabled || !matchesSettingsSearch(searchQuery, ACTION_RECIPES_SEARCH_ENTRY)) {
    return null
  }

  return (
    <SearchableSetting
      title={ACTION_RECIPES_SEARCH_ENTRY.title}
      description={ACTION_RECIPES_SEARCH_ENTRY.description}
      keywords={ACTION_RECIPES_SEARCH_ENTRY.keywords}
      className="space-y-3 px-1 py-2"
    >
      <div className="space-y-0.5">
        <Label>{ACTION_RECIPES_SEARCH_ENTRY.title}</Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.SourceControlAiActionRecipeDefaults.bf84dea6af',
            'Use variables only when you want Orca to inject context. Leave the agent as default to follow your normal agent preference.'
          )}
        </p>
      </div>
      <div className="space-y-3">
        {SOURCE_CONTROL_ACTION_IDS.map((actionId) => {
          const recipe = config.actions?.[actionId]
          const selectedAgent = recipe?.agentId ?? null
          const overrideSummary = overrideSummaries[actionId]
          return (
            <SourceControlActionRecipeRow
              key={actionId}
              actionId={actionId}
              selectedAgent={selectedAgent as TuiAgent | CustomAgentId | null}
              draftValue={actionRecipeDraftState.values[actionId]}
              baseValue={actionRecipeDraftState.baseValues[actionId]}
              defaultTuiAgent={defaultTuiAgent}
              isSavingTemplate={savingActionTemplateIds[actionId] === true}
              repoOverrideNote={
                <SourceControlActionRepoOverrideNote
                  summary={overrideSummary}
                  onReviewRepo={(repoId) => openRepoSourceControlAiSettings(repoId, actionId)}
                />
              }
              onAgentChange={(id, value) => void onActionAgentChange(id, value)}
              onTemplateChange={onActionTemplateChange}
              onAgentArgsChange={onActionAgentArgsChange}
              onAppendVariable={appendVariable}
              onDiscard={discardActionTemplateDraft}
              onSave={(id) => void saveActionTemplateDraft(id)}
            />
          )
        })}
      </div>
    </SearchableSetting>
  )
}
