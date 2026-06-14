import type React from 'react'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../shared/source-control-ai-types'
import {
  readSourceControlAiModelChoiceForHost,
  selectSourceControlAiModelChoiceForHost
} from '../../../../shared/source-control-ai'
import {
  readSourceControlActionDefault,
  setSourceControlActionDefault
} from '../../../../shared/source-control-ai-actions'
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentCapability,
  getCommitMessageModel,
  isCustomAgentId,
  resolveCommitMessageAgentChoice,
  type CommitMessageAgentCapability,
  type CommitMessageModelCapability,
  type CustomAgentId
} from '../../../../shared/commit-message-agent-spec'
import { AgentIcon } from '@/lib/agent-catalog'
import { Terminal } from 'lucide-react'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { getAgentCatalogForAction } from './source-control-action-recipe-options'
import { translate } from '@/i18n/i18n'

const AI_COMMIT_ACTION_ID = 'commitMessage'
const DEFAULT_AI_COMMIT_AGENT_VALUE = '__default_ai_commit_agent__'

type SourceControlAiCommitDefaultsProps = {
  config: SourceControlAiSettings
  settings: GlobalSettings
  discoveryHostKey: string
  searchQuery: string
  writeConfig: (patch: SourceControlAiSettingsPatch) => Promise<void>
}

export function getAiCommitModelOptions(
  config: SourceControlAiSettings,
  hostKey: string,
  capability: CommitMessageAgentCapability
): CommitMessageModelCapability[] {
  const seen = new Set<string>()
  const discoveredModels =
    config.discoveredModelsByAgentByHost?.[hostKey]?.[capability.id] ??
    (hostKey === 'local' ? config.discoveredModelsByAgent?.[capability.id] : undefined) ??
    []
  return [...capability.models, ...discoveredModels].filter((model) => {
    if (seen.has(model.id)) {
      return false
    }
    seen.add(model.id)
    return true
  })
}

export function readAiCommitSelectedModelId(
  config: SourceControlAiSettings,
  hostKey: string,
  agentId: TuiAgent
): string | undefined {
  return (
    readSourceControlAiModelChoiceForHost(
      config.modelOverridesByOperation?.[AI_COMMIT_ACTION_ID],
      hostKey,
      agentId
    ) ??
    readSourceControlAiModelChoiceForHost(
      {
        selectedModelByAgent: config.selectedModelByAgent,
        selectedModelByAgentByHost: config.selectedModelByAgentByHost
      },
      hostKey,
      agentId
    )
  )
}

export function getAiCommitSelectedModel(args: {
  config: SourceControlAiSettings
  hostKey: string
  capability: CommitMessageAgentCapability
  models: readonly CommitMessageModelCapability[]
}): CommitMessageModelCapability | undefined {
  const selectedModelId = readAiCommitSelectedModelId(args.config, args.hostKey, args.capability.id)
  return (
    args.models.find((model) => model.id === selectedModelId) ??
    args.models.find((model) => model.id === args.capability.defaultModelId) ??
    (selectedModelId ? getCommitMessageModel(args.capability.id, selectedModelId) : undefined) ??
    args.models[0]
  )
}

function getAiCommitModelItems(
  models: readonly CommitMessageModelCapability[],
  selectedModel: CommitMessageModelCapability | undefined
): CommitMessageModelCapability[] {
  if (!selectedModel || models.some((model) => model.id === selectedModel.id)) {
    return [...models]
  }
  return [...models, selectedModel]
}

function resolveNextAiCommitModelId(
  modelOptions: readonly CommitMessageModelCapability[],
  agentId: TuiAgent,
  selectedModelId: string | undefined,
  fallbackModelId: string
): string {
  if (
    selectedModelId &&
    (modelOptions.some((model) => model.id === selectedModelId) ||
      getCommitMessageModel(agentId, selectedModelId))
  ) {
    return selectedModelId
  }
  return fallbackModelId
}

export function SourceControlAiCommitDefaults({
  config,
  settings,
  discoveryHostKey,
  searchQuery,
  writeConfig
}: SourceControlAiCommitDefaultsProps): React.JSX.Element | null {
  if (!config.enabled) {
    return null
  }

  const aiCommitRecipe = readSourceControlActionDefault(config.actions, AI_COMMIT_ACTION_ID)
  const aiCommitConfiguredAgent = aiCommitRecipe.agentId
  const aiCommitResolvedAgent = resolveCommitMessageAgentChoice(
    aiCommitConfiguredAgent,
    settings.defaultTuiAgent,
    settings.disabledTuiAgents
  )
  const aiCommitCapability =
    aiCommitResolvedAgent && !isCustomAgentId(aiCommitResolvedAgent)
      ? getCommitMessageAgentCapability(aiCommitResolvedAgent)
      : undefined
  const aiCommitModelOptions = aiCommitCapability
    ? getAiCommitModelOptions(config, discoveryHostKey, aiCommitCapability)
    : []
  const aiCommitSelectedModel = aiCommitCapability
    ? getAiCommitSelectedModel({
        config,
        hostKey: discoveryHostKey,
        capability: aiCommitCapability,
        models: aiCommitModelOptions
      })
    : undefined
  const aiCommitModelItems = getAiCommitModelItems(aiCommitModelOptions, aiCommitSelectedModel)

  const onAiCommitAgentChange = (value: string): void => {
    const agentId: TuiAgent | CustomAgentId | null =
      value === DEFAULT_AI_COMMIT_AGENT_VALUE
        ? null
        : value === CUSTOM_AGENT_ID
          ? CUSTOM_AGENT_ID
          : (value as TuiAgent)
    void writeConfig((current) => {
      const actions = setSourceControlActionDefault(current.actions, AI_COMMIT_ACTION_ID, {
        agentId
      })
      if (!agentId || isCustomAgentId(agentId)) {
        return { actions }
      }
      const capability = getCommitMessageAgentCapability(agentId)
      if (!capability) {
        return { actions }
      }
      const modelOptions = getAiCommitModelOptions(current, discoveryHostKey, capability)
      const selectedModelId = readAiCommitSelectedModelId(current, discoveryHostKey, agentId)
      const modelChoice = selectSourceControlAiModelChoiceForHost(
        current.modelOverridesByOperation?.[AI_COMMIT_ACTION_ID],
        discoveryHostKey,
        agentId,
        resolveNextAiCommitModelId(
          modelOptions,
          agentId,
          selectedModelId,
          capability.defaultModelId
        )
      )
      return {
        actions,
        modelOverridesByOperation: {
          ...current.modelOverridesByOperation,
          [AI_COMMIT_ACTION_ID]: modelChoice
        }
      }
    })
  }

  const onAiCommitModelChange = (modelId: string): void => {
    if (!aiCommitCapability) {
      return
    }
    void writeConfig((current) => {
      const currentChoice = current.modelOverridesByOperation?.[AI_COMMIT_ACTION_ID]
      const selectedModel = aiCommitModelItems.find((model) => model.id === modelId)
      const selectedThinkingByModel =
        selectedModel?.thinkingLevels && selectedModel.defaultThinkingLevel
          ? {
              ...currentChoice?.selectedThinkingByModel,
              [selectedModel.id]:
                currentChoice?.selectedThinkingByModel?.[selectedModel.id] ??
                selectedModel.defaultThinkingLevel
            }
          : currentChoice?.selectedThinkingByModel
      const modelChoice = selectSourceControlAiModelChoiceForHost(
        currentChoice,
        discoveryHostKey,
        aiCommitCapability.id,
        modelId
      )
      return {
        modelOverridesByOperation: {
          ...current.modelOverridesByOperation,
          [AI_COMMIT_ACTION_ID]: {
            ...modelChoice,
            ...(selectedThinkingByModel ? { selectedThinkingByModel } : {})
          }
        }
      }
    })
  }

  const rows: React.ReactNode[] = []
  if (
    matchesSettingsSearch(searchQuery, {
      title: translate(
        'auto.components.settings.CommitMessageAiPane.739166f977',
        'AI Commit Agent'
      ),
      description: translate(
        'auto.components.settings.CommitMessageAiPane.9ba3194716',
        'Agent used when AI Commit generates the textarea message from staged changes.'
      ),
      keywords: [
        translate('auto.components.settings.CommitMessageAiPane.0b7eafe55f', 'ai'),
        translate('auto.components.settings.CommitMessageAiPane.ca433708cb', 'commit'),
        translate('auto.components.settings.CommitMessageAiPane.4ec89c319e', 'agent'),
        translate('auto.components.settings.CommitMessageAiPane.a4de9c36d3', 'omp'),
        translate('auto.components.settings.CommitMessageAiPane.f121bec167', 'claude'),
        translate('auto.components.settings.CommitMessageAiPane.542e1a00a7', 'codex')
      ]
    })
  ) {
    rows.push(
      <SearchableSetting
        key="ai-commit-agent"
        title={translate(
          'auto.components.settings.CommitMessageAiPane.739166f977',
          'AI Commit Agent'
        )}
        description={translate(
          'auto.components.settings.CommitMessageAiPane.9ba3194716',
          'Agent used when AI Commit generates the textarea message from staged changes.'
        )}
        keywords={['ai', 'commit', 'agent', 'omp', 'claude', 'codex']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 space-y-1">
          <Label>
            {translate(
              'auto.components.settings.CommitMessageAiPane.739166f977',
              'AI Commit Agent'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CommitMessageAiPane.e7685e64d2',
              'Used only by the AI Commit dropdown action.'
            )}
          </p>
        </div>
        <Select
          value={aiCommitConfiguredAgent ?? DEFAULT_AI_COMMIT_AGENT_VALUE}
          onValueChange={onAiCommitAgentChange}
        >
          <SelectTrigger size="sm" className="h-8 w-56 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={DEFAULT_AI_COMMIT_AGENT_VALUE}>
              <span className="flex items-center gap-2">
                <Terminal className="size-3.5 text-muted-foreground" />
                {translate(
                  'auto.components.settings.CommitMessageAiPane.a873b82aa2',
                  'Use default agent'
                )}
              </span>
            </SelectItem>
            <SelectItem value={CUSTOM_AGENT_ID}>
              <span className="flex items-center gap-2">
                <Terminal className="size-3.5 text-muted-foreground" />
                {translate(
                  'auto.components.settings.CommitMessageAiPane.0740d30915',
                  'Custom command'
                )}
              </span>
            </SelectItem>
            {getAgentCatalogForAction(AI_COMMIT_ACTION_ID, aiCommitConfiguredAgent).map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                <span className="flex items-center gap-2">
                  <AgentIcon agent={agent.id} size={14} />
                  {agent.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SearchableSetting>
    )
  }

  if (
    matchesSettingsSearch(searchQuery, {
      title: translate(
        'auto.components.settings.CommitMessageAiPane.b5e533eb3e',
        'AI Commit Model'
      ),
      description: translate(
        'auto.components.settings.CommitMessageAiPane.b51185176d',
        'Model used by the selected AI Commit agent.'
      ),
      keywords: [
        translate('auto.components.settings.CommitMessageAiPane.0b7eafe55f', 'ai'),
        translate('auto.components.settings.CommitMessageAiPane.ca433708cb', 'commit'),
        translate('auto.components.settings.CommitMessageAiPane.407d28bde6', 'model'),
        translate('auto.components.settings.CommitMessageAiPane.4ec89c319e', 'agent'),
        translate('auto.components.settings.CommitMessageAiPane.a4de9c36d3', 'omp')
      ]
    })
  ) {
    const modelUnavailableText = isCustomAgentId(aiCommitResolvedAgent)
      ? translate(
          'auto.components.settings.CommitMessageAiPane.dff38dd412',
          'Custom command does not use a model picker.'
        )
      : translate(
          'auto.components.settings.CommitMessageAiPane.59744f417e',
          'Choose a supported AI Commit agent to change models.'
        )
    rows.push(
      <SearchableSetting
        key="ai-commit-model"
        title={translate(
          'auto.components.settings.CommitMessageAiPane.b5e533eb3e',
          'AI Commit Model'
        )}
        description={translate(
          'auto.components.settings.CommitMessageAiPane.b51185176d',
          'Model used by the selected AI Commit agent.'
        )}
        keywords={['ai', 'commit', 'model', 'agent', 'omp']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 space-y-1">
          <Label>
            {translate(
              'auto.components.settings.CommitMessageAiPane.b5e533eb3e',
              'AI Commit Model'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {aiCommitCapability
              ? translate(
                  'auto.components.settings.CommitMessageAiPane.b51185176d',
                  'Model used by the selected AI Commit agent.'
                )
              : modelUnavailableText}
          </p>
        </div>
        <Select
          value={aiCommitSelectedModel?.id}
          onValueChange={onAiCommitModelChange}
          disabled={!aiCommitCapability || aiCommitModelItems.length === 0}
        >
          <SelectTrigger size="sm" className="h-8 w-56 text-xs">
            <SelectValue
              placeholder={translate(
                'auto.components.settings.CommitMessageAiPane.f148316d20',
                'No model available'
              )}
            />
          </SelectTrigger>
          <SelectContent align="end">
            {aiCommitModelItems.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SearchableSetting>
    )
  }

  return rows.length > 0 ? <>{rows}</> : null
}
