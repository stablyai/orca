import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from '../catalog-providers/agent-session-option-catalog-types'
import type { AgentSessionOptionChoice } from '../../agent-session-wire'
import type { AgentSessionOptionsResult } from '../protocol/agent-session-options-result'
import type { AgentType } from '../../../agent-status/contracts/agent-status-types'
import { usesModelSpecificAcpEfforts } from './agent-model-catalog-ownership'
import { unlistedModelLabel } from './model-id-label'

export function structuredModelEfforts(
  model: AgentSessionOptionsResult['models'][number]
): AgentSessionOptionChoice[] {
  return [...model.efforts, ...(model.chatEfforts ?? [])]
}

function effortOption(
  model: AgentSessionOptionsResult['models'][number],
  agent: AgentType
): CatalogOption | null {
  const levels = structuredModelEfforts(model)
  // Pi menus are exact; other agents (OMP's recorded menus) still offer unconfirmed choices.
  if ((agent === 'pi' && model.effortsKnown === false) || levels.length === 0) {
    return null
  }
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: levels,
      defaultValue: model.defaultEffort ?? levels[0]!.value,
      ...(model.defaultEffort ? { defaultIsCliDefault: true as const } : {})
    },
    apply: { midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` } }
  }
}

function contextWindowOption(
  model: AgentSessionOptionsResult['models'][number]
): CatalogOption | null {
  const sizes = model.contextWindows
  if (!sizes?.length) {
    return null
  }
  return {
    id: 'contextWindow',
    label: 'Context window',
    category: 'model_config',
    kind: {
      type: 'select',
      choices: sizes,
      defaultValue: model.defaultContextWindow ?? sizes[0]!.value,
      ...(model.defaultContextWindow ? { defaultIsCliDefault: true as const } : {})
    },
    apply: {}
  }
}

function fastModeOption(defaultValue: boolean): CatalogOption {
  return {
    id: 'fastMode',
    label: 'Fast mode',
    category: 'mode',
    kind: { type: 'boolean', defaultValue },
    apply: {}
  }
}

/** The tier Codex names Fast, by label or id; the only one the single Fast toggle stands for. */
export function isFastServiceTier(
  tier: Pick<AgentSessionOptionChoice, 'label' | 'value'>
): boolean {
  return tier.label.toLowerCase() === 'fast' || tier.value.toLowerCase() === 'fast'
}

/** Standard plus the tiers the model lists, valued by tier id; one choice in place of Fast. */
export function serviceTierOption(tiers: readonly AgentSessionOptionChoice[]): CatalogOption {
  return {
    id: 'serviceTier',
    label: 'Speed',
    category: 'mode',
    kind: {
      type: 'select',
      choices: [{ value: 'default', label: 'Standard' }, ...tiers],
      defaultValue: 'default'
    },
    apply: {}
  }
}

export function discoveredModel(
  model: AgentSessionOptionsResult['models'][number],
  sessionSupportsFastMode: boolean,
  agent: AgentType
): CatalogModel {
  const effort = effortOption(model, agent)
  const contextWindow = contextWindowOption(model)
  const serviceTier = model.serviceTiers?.length ? serviceTierOption(model.serviceTiers) : null
  return {
    ...(usesModelSpecificAcpEfforts(agent) && model.effortsKnown === false
      ? { effortsKnown: false as const }
      : {}),
    ...(model.declaredDefaultEffort !== undefined
      ? { declaredDefaultEffort: model.declaredDefaultEffort }
      : {}),
    id: model.id,
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
    ...(model.supportsAutoMode !== undefined ? { supportsAutoMode: model.supportsAutoMode } : {}),
    options: [
      ...(effort ? [effort] : []),
      ...(contextWindow ? [contextWindow] : []),
      ...(serviceTier
        ? [serviceTier]
        : sessionSupportsFastMode && model.supportsFastMode === true
          ? [fastModeOption(model.defaultFastMode === true)]
          : [])
    ]
  }
}

export function structuredAgentSessionOptionCatalog(
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult,
  agent: AgentType
): AgentSessionOptionCatalog {
  const models: CatalogModel[] = result.models.map((model) =>
    discoveredModel(model, result.fastModeSupport?.supported === true, agent)
  )
  if (result.current.model && !models.some((model) => model.id === result.current.model)) {
    models.push({
      id: result.current.model,
      label: unlistedModelLabel(agent, result.current.model),
      description: result.current.model,
      options: seed.unknownModelOptions ?? []
    })
  }
  return { ...seed, models, defaultModelIsCliDefault: true }
}
