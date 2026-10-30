import type { CatalogModel, CatalogOption } from './agent-session-option-catalog'
import type { AgentSessionOptionChoice, AgentSessionOptionsResult } from './agent-session-wire'
import type { AgentType } from './agent-status-types'

function effortOption(
  model: AgentSessionOptionsResult['models'][number],
  agent: AgentType | undefined
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
      choices: model.efforts,
      defaultValue: model.defaultEffort ?? model.efforts[0]!.value,
      ...(model.defaultEffort ? { defaultIsCliDefault: true as const } : {})
    },
    apply: { midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` } }
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
  agent?: AgentType
): CatalogModel {
  const effort = effortOption(model, agent)
  const serviceTier = model.serviceTiers?.length ? serviceTierOption(model.serviceTiers) : null
  return {
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
    ...(model.supportsAutoMode !== undefined ? { supportsAutoMode: model.supportsAutoMode } : {}),
    options: [
      ...(effort ? [effort] : []),
      ...(serviceTier
        ? [serviceTier]
        : sessionSupportsFastMode && model.supportsFastMode === true
          ? [fastModeOption()]
          : [])
    ]
  }
}
