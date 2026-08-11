import { useEffect, useMemo, useState } from 'react'
import type { TuiAgent } from '../../../../shared/types'
import type { CommitMessageModelCapability } from '../../../../shared/commit-message-agent-spec'
import { getCommitMessageAgentSpec } from '../../../../shared/commit-message-agent-spec'
import type {
  OrchestrationWorkerEfforts,
  OrchestrationWorkerModels
} from '../../../../shared/orchestration-worker-model-settings'
import {
  getOrchestrationWorkerEffortOption,
  resolveOrchestrationWorkerEffort,
  supportsLaunchModel
} from '../../../../shared/orchestration-worker-model-settings'
import {
  getAgentSessionOptionCatalog,
  mergeCatalogModels,
  type AgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsSubsectionHeader } from './SettingsFormControls'

const AGENT_DEFAULT_MODEL = '__agent_default__'
const AGENT_DEFAULT_EFFORT = '__agent_default_effort__'
const REQUIRE_EXPLICIT_AGENT = '__require_explicit_agent__'

type WorkerModelAgent = {
  id: TuiAgent
  label: string
  models: CatalogModel[]
}

type DiscoveredModels = Partial<Record<TuiAgent, CommitMessageModelCapability[]>>

function toDiscoveredCatalogModel(
  catalog: AgentSessionOptionCatalog,
  model: CommitMessageModelCapability
): CatalogModel {
  const fallbackOptions = catalog.unknownModelOptions ?? []
  const fallbackEffort = fallbackOptions.find((option) => option.id === 'effort')
  if (!model.thinkingLevels?.length || fallbackEffort?.kind.type !== 'select') {
    return { id: model.id, label: model.label, options: fallbackOptions }
  }

  const choices = model.thinkingLevels.map(({ id, label }) => ({
    value: id,
    label
  }))
  const defaultValue =
    (model.defaultThinkingLevel &&
      choices.some((choice) => choice.value === model.defaultThinkingLevel) &&
      model.defaultThinkingLevel) ||
    (choices.some((choice) => choice.value === fallbackEffort.kind.defaultValue)
      ? fallbackEffort.kind.defaultValue
      : choices[0].value)
  const discoveredEffort = {
    ...fallbackEffort,
    kind: { ...fallbackEffort.kind, choices, defaultValue }
  }

  return {
    id: model.id,
    label: model.label,
    options: fallbackOptions.map((option) => (option.id === 'effort' ? discoveredEffort : option))
  }
}

export function getWorkerModelAgents(discoveredModels: DiscoveredModels = {}): WorkerModelAgent[] {
  return getAgentCatalog().flatMap((agent) => {
    const catalog = getAgentSessionOptionCatalog(agent.id)
    return catalog && supportsLaunchModel(agent.id)
      ? [
          {
            id: agent.id,
            label: agent.label,
            models: mergeCatalogModels(
              catalog.models,
              (discoveredModels[agent.id] ?? []).map((model) =>
                toDiscoveredCatalogModel(catalog, model)
              )
            )
          }
        ]
      : []
  })
}

export function updateOrchestrationWorkerModel(
  currentModels: OrchestrationWorkerModels | null | undefined,
  currentEfforts: OrchestrationWorkerEfforts | null | undefined,
  agent: TuiAgent,
  model: string,
  modelOverride?: CatalogModel
): { models: OrchestrationWorkerModels; efforts: OrchestrationWorkerEfforts } {
  const models = { ...currentModels }
  const efforts = { ...currentEfforts }
  if (model === AGENT_DEFAULT_MODEL) {
    delete models[agent]
    delete efforts[agent]
  } else {
    models[agent] = model
    const option = getOrchestrationWorkerEffortOption(agent, model, modelOverride)
    if (
      option?.kind.type !== 'select' ||
      !option.kind.choices.some((choice) => choice.value === efforts[agent])
    ) {
      delete efforts[agent]
    }
  }
  return { models, efforts }
}

export function updateOrchestrationWorkerEffort(
  current: OrchestrationWorkerEfforts | null | undefined,
  agent: TuiAgent,
  effort: string
): OrchestrationWorkerEfforts {
  const next = { ...current }
  if (effort === AGENT_DEFAULT_EFFORT) {
    delete next[agent]
  } else {
    next[agent] = effort
  }
  return next
}

export function OrchestrationWorkerModelSetting(props: {
  defaultAgent: TuiAgent | null | undefined
  disabledAgents: TuiAgent[] | null | undefined
  models: OrchestrationWorkerModels | null | undefined
  efforts: OrchestrationWorkerEfforts | null | undefined
  onDefaultAgentChange: (agent: TuiAgent | null) => void
  onChange: (models: OrchestrationWorkerModels, efforts: OrchestrationWorkerEfforts) => void
}): React.JSX.Element {
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModels>({})
  const defaultWorkerAgents = useMemo(
    () => getAgentCatalog().filter((agent) => isTuiAgentEnabled(agent.id, props.disabledAgents)),
    [props.disabledAgents]
  )
  const modelAgents = useMemo(() => getWorkerModelAgents(discoveredModels), [discoveredModels])
  const selectedAgent = defaultWorkerAgents.some((agent) => agent.id === props.defaultAgent)
    ? props.defaultAgent
    : null
  const selectedAgentLabel =
    defaultWorkerAgents.find((agent) => agent.id === selectedAgent)?.label ?? 'Worker'

  // Why: only the selected worker's own catalog is reachable, so model and effort
  // narrow from the agent above them instead of listing every agent at once.
  const modelAgent = modelAgents.find((agent) => agent.id === selectedAgent)
  const selectedModel = selectedAgent ? props.models?.[selectedAgent] : undefined
  const selectedModelCatalog = modelAgent?.models.find((model) => model.id === selectedModel)
  const effortOption = selectedAgent
    ? getOrchestrationWorkerEffortOption(selectedAgent, selectedModel, selectedModelCatalog)
    : undefined
  const effortChoices = effortOption?.kind.type === 'select' ? effortOption.kind.choices : []
  const selectedEffort =
    (selectedAgent
      ? resolveOrchestrationWorkerEffort(
          selectedAgent,
          selectedModel,
          props.efforts?.[selectedAgent],
          selectedModelCatalog
        )
      : undefined) ?? AGENT_DEFAULT_EFFORT
  const modelSelectValue = modelAgent ? (selectedModel ?? AGENT_DEFAULT_MODEL) : undefined
  const effortSelectEnabled = modelAgent !== undefined && effortChoices.length > 0
  const modelPlaceholder = selectedAgent
    ? translate(
        'auto.components.settings.OrchestrationWorkerModelSetting.modelUnavailable',
        'Not available'
      )
    : translate(
        'auto.components.settings.OrchestrationWorkerModelSetting.modelPlaceholder',
        'Pick provider'
      )
  const effortPlaceholder = !selectedAgent
    ? translate(
        'auto.components.settings.OrchestrationWorkerModelSetting.effortPlaceholderNoProvider',
        'Pick provider'
      )
    : !modelAgent
      ? translate(
          'auto.components.settings.OrchestrationWorkerModelSetting.effortUnavailable',
          'Not available'
        )
      : selectedModel
        ? translate(
            'auto.components.settings.OrchestrationWorkerModelSetting.effortUnavailable',
            'Not available'
          )
        : translate(
            'auto.components.settings.OrchestrationWorkerModelSetting.effortPlaceholder',
            'Select model'
          )
  // Why: a model persisted from another host may be absent from this host's list;
  // keep it selectable so opening settings does not silently discard it.
  const customSelectedModel =
    selectedModel && modelAgent && !modelAgent.models.some((model) => model.id === selectedModel)
      ? selectedModel
      : null
  const selectedModelLabel = selectedModel
    ? (modelAgent?.models.find((model) => model.id === selectedModel)?.label ?? selectedModel)
    : undefined

  useEffect(() => {
    let cancelled = false
    const dynamicAgents = getWorkerModelAgents().filter(
      (agent) => getCommitMessageAgentSpec(agent.id)?.modelSource === 'dynamic'
    )
    void Promise.all(
      dynamicAgents.map(async (agent) => {
        try {
          const result = await window.api.git.discoverCommitMessageModels({ agentId: agent.id })
          return result.success ? ([agent.id, result.models] as const) : null
        } catch {
          return null
        }
      })
    ).then((results) => {
      if (cancelled) {
        return
      }
      setDiscoveredModels(
        Object.fromEntries(results.filter((result) => result !== null)) as DiscoveredModels
      )
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="space-y-2 rounded-md border border-border px-4 py-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.OrchestrationWorkerModelSetting.workerDefaultsTitle',
          'Worker defaults'
        )}
        description={translate(
          'auto.components.settings.OrchestrationWorkerModelSetting.workerDefaultsDescription',
          'Choose the provider, model, and reasoning effort to store as your orchestration worker preference.'
        )}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-2">
        <Select
          value={selectedAgent ?? REQUIRE_EXPLICIT_AGENT}
          onValueChange={(value) =>
            props.onDefaultAgentChange(
              value === REQUIRE_EXPLICIT_AGENT ? null : (value as TuiAgent)
            )
          }
        >
          <SelectTrigger
            size="sm"
            className="w-fit min-w-[min(13rem,100%)] max-w-full"
            aria-label={translate(
              'auto.components.settings.OrchestrationWorkerModelSetting.defaultWorkerSelectLabel',
              'Default worker provider'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={REQUIRE_EXPLICIT_AGENT}>
              {translate(
                'auto.components.settings.OrchestrationWorkerModelSetting.requireAgent',
                'No default worker'
              )}
            </SelectItem>
            {defaultWorkerAgents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                <span className="flex items-center gap-2">
                  <AgentIcon agent={agent.id} size={14} />
                  {agent.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={modelSelectValue}
          disabled={!modelAgent}
          onValueChange={(model) => {
            if (!modelAgent) {
              return
            }
            const next = updateOrchestrationWorkerModel(
              props.models,
              props.efforts,
              modelAgent.id,
              model,
              modelAgent.models.find((candidate) => candidate.id === model)
            )
            props.onChange(next.models, next.efforts)
          }}
        >
          <SelectTrigger
            size="sm"
            className="min-w-0 w-48 max-w-full"
            aria-label={translate(
              'auto.components.settings.OrchestrationWorkerModelSetting.modelSelectLabel',
              '{{value0}} model',
              { value0: selectedAgentLabel }
            )}
            title={selectedModelLabel}
          >
            <SelectValue placeholder={modelPlaceholder} />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={AGENT_DEFAULT_MODEL}>
              {translate(
                'auto.components.settings.OrchestrationWorkerModelSetting.agentDefault',
                'Agent default'
              )}
            </SelectItem>
            {customSelectedModel ? (
              <SelectItem value={customSelectedModel}>{customSelectedModel}</SelectItem>
            ) : null}
            {modelAgent?.models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={effortSelectEnabled ? selectedEffort : undefined}
          disabled={!effortSelectEnabled}
          onValueChange={(effort) => {
            if (!modelAgent) {
              return
            }
            props.onChange(
              props.models ?? {},
              updateOrchestrationWorkerEffort(props.efforts, modelAgent.id, effort)
            )
          }}
        >
          <SelectTrigger
            size="sm"
            className="min-w-0 w-36 max-w-full"
            aria-label={translate(
              'auto.components.settings.OrchestrationWorkerModelSetting.effortSelectLabel',
              '{{value0}} effort',
              { value0: selectedAgentLabel }
            )}
          >
            <SelectValue placeholder={effortPlaceholder} />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={AGENT_DEFAULT_EFFORT}>
              {translate(
                'auto.components.settings.OrchestrationWorkerModelSetting.effortDefault',
                'Agent default'
              )}
            </SelectItem>
            {effortChoices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.settings.OrchestrationWorkerModelSetting.defaultHint',
          'Agent default stores no model or effort override. Available effort levels follow the selected model.'
        )}
      </p>
    </section>
  )
}
