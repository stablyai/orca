import { agentPickerCatalogView } from './agent-launch-picker-source'
import { modelMenuOptions } from '../../agent-session/options/model-menu-options'
import { listedModelDescribing } from '../../agent-session/options/structured-agent-session-listed-model'
import {
  discoveredModel,
  structuredModelEfforts
} from '../../agent-session/options/structured-agent-session-discovered-model'
import { createClaudeCatalogOptions } from '../../agent-session/options/agent-session-option-catalog-claude-codex'
import type { CatalogOption } from '../../agent-session/options/agent-session-option-catalog-types'
import { getAgentSessionOptionLaunchCatalog } from '../../agent-session/options/agent-session-option-catalog'
import { sourceControlActionOptions } from '../../source-control/ai/recipes/source-control-action-options'
import {
  agentPermissionChoices,
  agentPermissionHasTerminalChoice
} from '../permissions/tui-agent-permission-choice'
import type { TuiAgent } from '../catalog/tui-agent'
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
  if (entry.textGeneration) {
    const live = agentPickerModels(entry).find((row) => row.id === (model ?? entry.terminal.model))
    return live?.efforts.length
      ? [
          {
            id: 'effort',
            label: 'Reasoning effort',
            category: 'thought_level',
            kind: { type: 'select', choices: live.efforts, defaultValue: live.defaultEffort ?? '' },
            apply: {}
          }
        ]
      : []
  }
  const view = agentPickerCatalogView(entry, surface)
  let options = agentPickerOptions(entry.agent, model, surface)
  const rows = agentPickerModelMenu(entry, surface).rows
  const live = model
    ? listedModelDescribing(rows, undefined, model)
    : rows.find((row) => row.isDefault)
  if (!live && model) {
    return []
  }
  if (view.catalog.origin === 'unknown' || !live) {
    return options.filter(
      (option) => option.kind.type !== 'select' || option.kind.choices.length > 0
    )
  }
  if (entry.agent === 'claude') {
    options = createClaudeCatalogOptions({
      effortLevelIds: live.efforts.map((choice) => choice.value),
      supportsFastMode:
        live.supportsFastMode === true && view.catalog.fastModeSupport?.supported !== false
    })
  }
  if (surface === 'chat' || entry.agent === 'codex') {
    const dynamic = discoveredModel(
      live,
      view.catalog.fastModeSupport?.supported !== false,
      entry.agent
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
      return []
    }
    return [
      {
        ...option,
        kind: {
          type: 'select' as const,
          choices: surface === 'chat' ? structuredModelEfforts(live) : live.efforts,
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

export function agentPickerModelMenu(
  entry: AgentPickerEntry,
  surface: AgentPickerSurface = entry.defaultSurface,
  saved?: Readonly<Record<string, string>>
) {
  const view = agentPickerCatalogView(entry, surface)
  return modelMenuOptions(view.catalog, {
    agent: entry.agent,
    surface: entry.textGeneration ? 'textGeneration' : surface,
    seed: getAgentSessionOptionLaunchCatalog(entry.agent) ?? { models: [], modelApply: {} },
    pending: view.catalogRead === 'pending',
    coherentCatalog: view.coherentCatalog,
    newLaunch: true,
    seedsModel: true,
    saved
  })
}

export function agentPickerModels(
  entry: AgentPickerEntry,
  surface: AgentPickerSurface = entry.defaultSurface
): AgentPickerModel[] {
  if (entry.textGeneration && entry.catalog.origin !== 'unknown') {
    return entry.catalog.models
  }
  return agentPickerModelMenu(entry, surface).rows
}

export function agentPickerNamesConfiguredModel(
  entry: AgentPickerEntry,
  surface: AgentPickerSurface
) {
  const { catalog } = agentPickerCatalogView(entry, surface)
  return (
    catalog.origin !== 'unknown' &&
    (catalog.listingNamesConfiguredModel ??
      getAgentSessionOptionLaunchCatalog(entry.agent)?.hostListingNamesConfiguredModel === true)
  )
}
