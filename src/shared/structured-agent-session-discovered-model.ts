import type { CatalogModel, CatalogOption } from './agent-session-option-catalog'
import type { AgentSessionOptionChoice, AgentSessionOptionsResult } from './agent-session-wire'

// The picker options one listed model offers, built from what its host reported.

function effortOption(model: AgentSessionOptionsResult['models'][number]): CatalogOption | null {
  if (model.efforts.length <= 1) {
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
function serviceTierOption(tiers: readonly AgentSessionOptionChoice[]): CatalogOption {
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
  sessionSupportsFastMode: boolean
): CatalogModel {
  const effort = effortOption(model)
  const serviceTier = model.serviceTiers?.length ? serviceTierOption(model.serviceTiers) : null
  return {
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
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
