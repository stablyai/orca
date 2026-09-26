import { useEffect, useMemo, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import {
  getCommitMessageAgentSpec,
  type CommitMessageModelCapability
} from '../../../../shared/commit-message-agent-spec'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsSwitch } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getExperimentalSearchEntry } from './experimental-search'
import { useTranslation } from 'react-i18next'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function ConversationKnowledgeExperimentalSetting({ settings, updateSettings }: Props) {
  useTranslation()
  const searchEntry = getExperimentalSearchEntry().conversationKnowledge
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const knowledgeAgents = ALL_TUI_AGENTS.filter(
    (agent) =>
      detectedAgentIds?.includes(agent) === true &&
      isTuiAgentEnabled(agent, settings.disabledTuiAgents) &&
      getCommitMessageAgentSpec(agent) !== undefined
  )
  const selectedKnowledgeAgent = knowledgeAgents.find(
    (agent) => agent === settings.conversationKnowledgeEnrichmentAgent
  )
  const [discoveredModels, setDiscoveredModels] = useState<
    Partial<Record<TuiAgent, CommitMessageModelCapability[]>>
  >({})
  const knowledgeAgentKey = knowledgeAgents.join('|')
  const shouldDiscoverModels =
    settings.conversationKnowledgeEnabled === true &&
    settings.conversationKnowledgeEnrichmentEnabled === true

  // Refresh the local CLI catalogs so custom providers (for example MiniMax
  // behind Claude-compatible configuration) appear alongside static fallbacks.
  useEffect(() => {
    let cancelled = false
    const discover = async () => {
      const agents = knowledgeAgentKey
        ? ALL_TUI_AGENTS.filter((agent) => knowledgeAgentKey.split('|').includes(agent))
        : []
      const results = await Promise.all(
        agents.map(async (agent) => {
          try {
            const result = await window.api.git.discoverCommitMessageModels({ agentId: agent })
            return result.success ? ([agent, result.models] as const) : null
          } catch {
            return null
          }
        })
      )
      if (cancelled) {
        return
      }
      setDiscoveredModels((current) => {
        const next = { ...current }
        for (const result of results) {
          if (result) {
            next[result[0]] = result[1]
          }
        }
        return next
      })
    }
    if (shouldDiscoverModels && knowledgeAgentKey) {
      void discover()
    }
    return () => {
      cancelled = true
    }
  }, [knowledgeAgentKey, shouldDiscoverModels])

  const knowledgeModels = useMemo(() => {
    if (!selectedKnowledgeAgent) {
      return []
    }
    const specModels = getCommitMessageAgentSpec(selectedKnowledgeAgent)?.models ?? []
    const persistedModels =
      settings.sourceControlAi?.discoveredModelsByAgent?.[selectedKnowledgeAgent] ?? []
    const runtimeModels = discoveredModels[selectedKnowledgeAgent] ?? []
    const models = [...runtimeModels, ...persistedModels, ...specModels]
    const unique = new Map(models.map((model) => [model.id, model]))
    const configuredModel = settings.conversationKnowledgeEnrichmentModel
    if (configuredModel && !unique.has(configuredModel)) {
      unique.set(configuredModel, { id: configuredModel, label: configuredModel })
    }
    return [...unique.values()]
  }, [
    discoveredModels,
    selectedKnowledgeAgent,
    settings.conversationKnowledgeEnrichmentModel,
    settings.sourceControlAi?.discoveredModelsByAgent
  ])

  return (
    <SearchableSetting
      {...searchEntry}
      id="experimental-conversation-knowledge"
      className="space-y-3 py-2"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{translate('conversationKnowledge.name', 'Conversation Knowledge')}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'conversationKnowledge.settings.description',
              'Adds a graph and detail workspace for exploring generated topics, conclusions, projects, worktrees, and source sessions.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={settings.conversationKnowledgeEnabled === true}
          ariaLabel={translate(
            'conversationKnowledge.settings.toggle',
            'Toggle Conversation Knowledge'
          )}
          onChange={() =>
            updateSettings({
              conversationKnowledgeEnabled: settings.conversationKnowledgeEnabled !== true
            })
          }
        />
      </div>
      {settings.conversationKnowledgeEnabled === true ? (
        <div className="ml-4 space-y-3 border-l-2 border-border/60 py-2 pl-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate('conversationKnowledge.enrichment', 'AI Knowledge Enrichment')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'conversationKnowledge.enrichmentCopy',
                  'Checks for new or changed sessions once per day and turns them into summaries, topics, conclusions, and graph relationships.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={settings.conversationKnowledgeEnrichmentEnabled === true}
              ariaLabel={translate(
                'conversationKnowledge.enrichmentToggle',
                'Toggle AI Knowledge Enrichment'
              )}
              onChange={() =>
                updateSettings({
                  conversationKnowledgeEnrichmentEnabled:
                    settings.conversationKnowledgeEnrichmentEnabled !== true
                })
              }
            />
          </div>
          {settings.conversationKnowledgeEnrichmentEnabled === true ? (
            <div className="space-y-3 border-t border-border pt-3">
              <div>
                <p className="mb-1.5 text-xs font-medium">
                  {translate('conversationKnowledge.settings.summaryAgent', 'Summary agent')}
                </p>
                <Select
                  value={selectedKnowledgeAgent ?? undefined}
                  onValueChange={(value) => {
                    const agent = knowledgeAgents.find((candidate) => candidate === value)
                    if (!agent) {
                      return
                    }
                    updateSettings({
                      conversationKnowledgeEnrichmentAgent: agent,
                      conversationKnowledgeEnrichmentModel:
                        getCommitMessageAgentSpec(agent)?.defaultModelId ?? null
                    })
                  }}
                >
                  <SelectTrigger size="sm" className="w-full max-w-72">
                    <SelectValue
                      placeholder={translate(
                        'conversationKnowledge.settings.chooseAgent',
                        'Choose an enabled agent'
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {knowledgeAgents.map((agent) => (
                      <SelectItem key={agent} value={agent}>
                        {TUI_AGENT_DISPLAY_NAMES[agent]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {translate(
                    'conversationKnowledge.settings.agentHelp',
                    'Only detected, enabled agents that support background generation are shown.'
                  )}
                </p>
              </div>
              {selectedKnowledgeAgent ? (
                <div>
                  <p className="mb-1.5 text-xs font-medium">
                    {translate('conversationKnowledge.settings.summaryModel', 'Summary model')}
                  </p>
                  <Select
                    value={
                      settings.conversationKnowledgeEnrichmentModel ??
                      getCommitMessageAgentSpec(selectedKnowledgeAgent)?.defaultModelId
                    }
                    onValueChange={(model) =>
                      updateSettings({ conversationKnowledgeEnrichmentModel: model })
                    }
                  >
                    <SelectTrigger size="sm" className="w-full max-w-72">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {knowledgeModels.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </SearchableSetting>
  )
}
