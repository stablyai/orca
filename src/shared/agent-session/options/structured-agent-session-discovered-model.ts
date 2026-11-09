import type { CatalogModel, CatalogOption } from './agent-session-option-catalog-types'
import type { AgentSessionOptionChoice } from '../agent-session-wire'
import type { AgentSessionOptionsResult } from './agent-session-options-result'
import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import { usesModelSpecificAcpEfforts } from './agent-model-catalog-ownership'

export function structuredModelEfforts(
  model: AgentSessionOptionsResult['models'][number]
): AgentSessionOptionChoice[] {
  // A host with the Ultracode switch still lists it as an effort for older clients.
  return model.supportsUltracode === true
    ? model.efforts
    : [...model.efforts, ...(model.chatEfforts ?? [])]
}

function effortOption(
  model: AgentSessionOptionsResult['models'][number],
  agent: AgentType
): CatalogOption | null {
  // Pi menus are exact; other agents (OMP's recorded menus) still offer unconfirmed choices.
  if ((agent === 'pi' && model.effortsKnown === false) || model.efforts.length === 0) {
    return null
  }
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: structuredModelEfforts(model),
      defaultValue: model.defaultEffort ?? model.efforts[0]!.value,
      ...(model.defaultEffort ? { defaultIsCliDefault: true as const } : {})
    },
    apply: { midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` } }
  }
}

function ultracodeOption(): CatalogOption {
  return {
    id: 'ultracode',
    label: 'Ultracode',
    category: 'mode',
    kind: { type: 'boolean', defaultValue: false },
    apply: {}
  }
}

function fastModeOption(): CatalogOption {
  return {
    id: 'fastMode',
    label: 'Fast mode',
    category: 'mode',
    kind: { type: 'boolean', defaultValue: false },
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
      ...(model.supportsUltracode === true ? [ultracodeOption()] : []),
      ...(serviceTier
        ? [serviceTier]
        : sessionSupportsFastMode && model.supportsFastMode === true
          ? [fastModeOption()]
          : [])
    ]
  }
}
