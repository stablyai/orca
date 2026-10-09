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

/** Standard plus the faster speeds the model lists; one choice in place of the Fast toggle. */
function speedOption(speeds: readonly AgentSessionOptionChoice[]): CatalogOption {
  return {
    id: 'speed',
    label: 'Speed',
    category: 'mode',
    kind: {
      type: 'select',
      choices: [{ value: 'standard', label: 'Standard' }, ...speeds],
      defaultValue: 'standard'
    },
    apply: {}
  }
}

export function discoveredModel(
  model: AgentSessionOptionsResult['models'][number],
  sessionSupportsFastMode: boolean
): CatalogModel {
  const effort = effortOption(model)
  const speed = model.speeds?.length ? speedOption(model.speeds) : null
  return {
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
    options: [
      ...(effort ? [effort] : []),
      ...(speed
        ? [speed]
        : sessionSupportsFastMode && model.supportsFastMode === true
          ? [fastModeOption()]
          : [])
    ]
  }
}
