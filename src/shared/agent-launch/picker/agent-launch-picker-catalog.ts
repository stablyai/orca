import { antigravityModelSelection } from '../../agent-session/options/antigravity-model-efforts'
import { modelMenuOptions } from '../../agent-session/options/model-menu-options'
import { listedModelDescribing } from '../../agent-session/options/structured-agent-session-listed-model'
import {
  discoveredModel,
  structuredModelEfforts
} from '../../agent-session/options/structured-agent-session-discovered-model'
import { createClaudeCatalogOptions } from '../../agent-session/options/agent-session-option-catalog-claude-codex'
import type {
  CatalogModel,
  CatalogOption
} from '../../agent-session/options/agent-session-option-catalog-types'
import { getAgentSessionOptionLaunchCatalog } from '../../agent-session/options/agent-session-option-catalog'
import { sourceControlActionOptions } from '../../source-control/ai/recipes/source-control-action-options'
import {
  agentPermissionChoices,
  agentPermissionHasTerminalChoice
} from '../permissions/tui-agent-permission-choice'
import type { TuiAgent } from '../catalog/tui-agent'
import type { AgentPickerEntry, AgentPickerModel, AgentPickerSurface } from './agent-launch-picker'

type ModelMenuEntry = Pick<AgentPickerEntry, 'agent' | 'catalog'> &
  Partial<
    Pick<
      AgentPickerEntry,
      | 'defaultSurface'
      | 'textGeneration'
      | 'catalogRead'
      | 'coherentCatalog'
      | 'terminalCatalog'
      | 'terminalCatalogRead'
    >
  >

export function agentPickerSurfaceCatalog(entry: ModelMenuEntry, surface: AgentPickerSurface) {
  return entry.agent === 'antigravity' && surface === 'terminal' && !entry.textGeneration
    ? {
        ...entry,
        catalog: entry.terminalCatalog ?? { origin: 'unknown' as const },
        catalogRead: entry.terminalCatalogRead
      }
    : entry
}

export function agentPickerOptions(
  agent: TuiAgent,
  model: string | undefined,
  surface: AgentPickerSurface
) {
  return sourceControlActionOptions(agent, model ?? '', surface)
    .filter(({ route }) => route === null || route === (surface === 'chat' ? 'chats' : 'terminals'))
    .map(({ option }) => option)
}

export function agentPickerEntryOptions(
  entry: ModelMenuEntry & Pick<AgentPickerEntry, 'terminal'>,
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
  const catalog = agentPickerSurfaceCatalog(entry, surface).catalog
  let options = agentPickerOptions(entry.agent, model, surface)
  const rows = agentPickerModels(entry, surface)
  const composer = agentPickerUsesComposerModelMenu(entry, surface)
  const live =
    entry.agent === 'antigravity' && surface === 'terminal'
      ? antigravityModelSelection(rows, model)?.row
      : composer
        ? model
          ? listedModelDescribing(rows, undefined, model)
          : rows.find((row) => row.isDefault)
        : rows.find((row) => row.id === model || (model === undefined && row.isDefault))
  if (composer && !live && model) {
    return []
  }
  if (catalog.origin === 'unknown' || !live) {
    return options.filter(
      (option) => option.kind.type !== 'select' || option.kind.choices.length > 0
    )
  }
  if (entry.agent === 'claude') {
    options = createClaudeCatalogOptions({
      effortLevelIds: live.efforts.map((choice) => choice.value),
      supportsFastMode:
        live.supportsFastMode === true && catalog.fastModeSupport?.supported !== false
    })
  }
  if (surface === 'chat' || entry.agent === 'codex') {
    const dynamic = discoveredModel(
      live,
      catalog.fastModeSupport?.supported !== false,
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
      return !composer && live.effortsKnown === false ? [option] : []
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
  entry: ModelMenuEntry,
  surface: AgentPickerSurface = entry.defaultSurface ?? 'terminal',
  saved?: Readonly<Record<string, string>>
) {
  return modelMenuOptions(entry.catalog, {
    agent: entry.agent,
    surface: entry.textGeneration ? 'textGeneration' : surface,
    seed: getAgentSessionOptionLaunchCatalog(entry.agent) ?? { models: [], modelApply: {} },
    pending: entry.catalogRead === 'pending',
    coherentCatalog: entry.coherentCatalog,
    newLaunch: true,
    seedsModel: true,
    saved
  })
}

export function agentPickerModels(
  entry: ModelMenuEntry,
  surface: AgentPickerSurface = entry.defaultSurface ?? 'terminal'
): AgentPickerModel[] {
  if (!agentPickerUsesComposerModelMenu(entry, surface)) {
    const catalog = agentPickerSurfaceCatalog(entry, surface).catalog
    if (catalog.origin !== 'unknown') {
      return catalog.models
    }
    return (getAgentSessionOptionLaunchCatalog(entry.agent)?.models ?? []).map(
      agentPickerModelFromCatalogModel
    )
  }
  return agentPickerModelMenu(entry, surface).rows
}

/** Terminal discovery is a separate change; these menus keep their existing catalog policy. */
export function agentPickerUsesComposerModelMenu(
  entry: ModelMenuEntry,
  surface: AgentPickerSurface
) {
  return !entry.textGeneration && !(entry.agent === 'antigravity' && surface === 'terminal')
}

export function agentPickerModelFromCatalogModel(model: CatalogModel): AgentPickerModel {
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    isDefault: model.isDefault === true,
    efforts: model.options.flatMap((option) =>
      option.id === 'effort' && option.kind.type === 'select' ? option.kind.choices : []
    )
  }
}
