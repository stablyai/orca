import { discoveredModel } from './structured-agent-session-discovered-model'
import {
  createClaudeCatalogOptions,
  type CatalogOption,
  getAgentSessionOptionLaunchCatalog
} from './agent-session-option-catalog'
import { sourceControlActionOptions } from './source-control-action-launch-preferences'
import {
  agentPermissionChoices,
  agentPermissionHasTerminalChoice
} from './tui-agent-permission-choice'
import type { TuiAgent } from './tui-agent'
import type { AgentPickerEntry, AgentPickerModel, AgentPickerSurface } from './agent-launch-picker'

export function agentPickerOptions(
  agent: TuiAgent,
  model: string | undefined,
  surface: AgentPickerSurface
) {
  return sourceControlActionOptions(agent, model ?? '')
    .filter(({ route }) => route === null || route === (surface === 'chat' ? 'chats' : 'terminals'))
    .map(({ option }) => option)
}

export function agentPickerEntryOptions(
  entry: AgentPickerEntry,
  model: string | undefined,
  surface: AgentPickerSurface
): CatalogOption[] {
  let options = agentPickerOptions(entry.agent, model, surface)
  const live = agentPickerModels(entry).find(
    (row) => row.id === model || (model === undefined && row.isDefault)
  )
  if (entry.catalog.origin === 'unknown' || !live) {
    return options.filter(
      (option) => option.kind.type !== 'select' || option.kind.choices.length > 0
    )
  }
  if (entry.agent === 'claude') {
    options = createClaudeCatalogOptions({
      effortLevelIds: live.efforts.map((choice) => choice.value),
      supportsFastMode:
        live.supportsFastMode === true && entry.catalog.fastModeSupport?.supported !== false
    })
  }
  if (surface === 'chat' || entry.agent === 'codex') {
    const dynamic = discoveredModel(
      live,
      entry.catalog.fastModeSupport?.supported !== false
    ).options
    if (entry.agent === 'codex') {
      options = options.filter((option) => option.id !== 'serviceTier' && option.id !== 'fastMode')
    }
    for (const option of dynamic) {
      if (!options.some((existing) => existing.id === option.id)) {
        const mapping = getAgentSessionOptionLaunchCatalog(entry.agent)?.unknownModelOptions?.find(
          (seed) => seed.id === option.id
        )
        options.push(mapping ? { ...option, apply: mapping.apply } : option)
      }
    }
  }
  return options.flatMap((option) => {
    if (option.id !== 'effort') {
      return [option]
    }
    if (!live.efforts.length) {
      return live.effortsKnown === false ? [option] : []
    }
    return [
      {
        ...option,
        kind: {
          type: 'select' as const,
          choices: live.efforts,
          defaultValue: live.defaultEffort ?? ''
        }
      }
    ]
  })
}

export function agentPickerPermissions(agent: TuiAgent, surface: AgentPickerSurface) {
  return agentPermissionChoices(agent).filter(
    (choice) => surface === 'chat' || agentPermissionHasTerminalChoice(agent, choice)
  )
}

export function agentPickerModels(entry: AgentPickerEntry): AgentPickerModel[] {
  if (entry.catalog.origin !== 'unknown') {
    return entry.catalog.models
  }
  return (getAgentSessionOptionLaunchCatalog(entry.agent)?.models ?? []).map((model) => ({
    id: model.id,
    label: model.label,
    description: model.description,
    isDefault: model.isDefault === true,
    efforts: model.options.flatMap((option) =>
      option.id === 'effort' && option.kind.type === 'select' ? option.kind.choices : []
    )
  }))
}
