import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog,
  type CatalogModel,
  type CatalogOption
} from './agent-session-option-catalog'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './types'

export type OrchestrationWorkerModels = Partial<Record<TuiAgent, string>>
export type OrchestrationWorkerEfforts = Partial<Record<TuiAgent, string>>

export function normalizeOrchestrationDefaultWorkerAgent(value: unknown): TuiAgent | null {
  return typeof value === 'string' && isTuiAgent(value) ? value : null
}

export function supportsLaunchModel(agent: TuiAgent): boolean {
  const catalog = getAgentSessionOptionCatalog(agent)
  return Boolean(catalog?.supportsWorkerLaunchPreferences && catalog.modelApply.launchArgs)
}

export function getOrchestrationWorkerEffortOption(
  agent: TuiAgent,
  modelId: string | null | undefined,
  modelOverride?: CatalogModel
): CatalogOption | undefined {
  const catalog = getAgentSessionOptionCatalog(agent)
  const normalizedModelId = modelId?.trim() ?? ''
  const model =
    modelOverride ?? (catalog ? findCatalogModel(catalog, normalizedModelId) : undefined)
  const option =
    findCatalogOption(model, 'effort') ??
    (!model && normalizedModelId
      ? catalog?.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
      : undefined)
  return option?.kind.type === 'select' &&
    (option.apply.launchArgs || option.apply.composedIntoModel)
    ? option
    : undefined
}

export function resolveOrchestrationWorkerEffort(
  agent: TuiAgent,
  modelId: string | null | undefined,
  effort: string | null | undefined,
  modelOverride?: CatalogModel
): string | undefined {
  const normalizedEffort = effort?.trim()
  const option = getOrchestrationWorkerEffortOption(agent, modelId, modelOverride)
  return normalizedEffort &&
    option?.kind.type === 'select' &&
    option.kind.choices.some((choice) => choice.value === normalizedEffort)
    ? normalizedEffort
    : undefined
}

function agentSupportsEffort(agent: TuiAgent, effort: string): boolean {
  const catalog = getAgentSessionOptionCatalog(agent)
  return Boolean(
    catalog?.models.some((model) => {
      const option = getOrchestrationWorkerEffortOption(agent, model.id)
      return (
        option?.kind.type === 'select' &&
        option.kind.choices.some((choice) => choice.value === effort)
      )
    })
  )
}

export function normalizeOrchestrationWorkerModels(value: unknown): OrchestrationWorkerModels {
  const normalized: OrchestrationWorkerModels = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return normalized
  }
  for (const [agent, rawModel] of Object.entries(value)) {
    if (!isTuiAgent(agent) || !supportsLaunchModel(agent) || typeof rawModel !== 'string') {
      continue
    }
    const model = rawModel.trim()
    if (model) {
      normalized[agent] = model
    }
  }
  return normalized
}

export function normalizeOrchestrationWorkerEfforts(value: unknown): OrchestrationWorkerEfforts {
  const normalized: OrchestrationWorkerEfforts = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return normalized
  }
  for (const [agent, rawEffort] of Object.entries(value)) {
    if (!isTuiAgent(agent) || typeof rawEffort !== 'string') {
      continue
    }
    const effort = rawEffort.trim()
    if (effort && agentSupportsEffort(agent, effort)) {
      normalized[agent] = effort
    }
  }
  return normalized
}
