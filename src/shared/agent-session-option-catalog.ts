import type { AgentType } from './agent-status-types'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG,
  codexCatalogModelFromCapability
} from './agent-session-option-catalog-claude-codex'
import {
  CURSOR_SESSION_OPTION_CATALOG,
  GEMINI_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-gemini-cursor'
import type {
  AgentSessionOptionCatalog,
  AgentSessionOptionCatalogMap,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import type { SessionOptionValue } from './native-chat-session-options'
import type { CommitMessageModelCapability } from './commit-message-agent-spec'

export type {
  AgentSessionOptionCatalog,
  CatalogAgentInteractionDetection,
  CatalogMidSessionApply,
  CatalogModel,
  CatalogOption,
  CatalogOptionApply
} from './agent-session-option-catalog-types'

const CATALOGS: AgentSessionOptionCatalogMap = {
  claude: CLAUDE_SESSION_OPTION_CATALOG,
  codex: CODEX_SESSION_OPTION_CATALOG,
  gemini: GEMINI_SESSION_OPTION_CATALOG,
  cursor: CURSOR_SESSION_OPTION_CATALOG
}

export function getAgentSessionOptionCatalog(agent: AgentType): AgentSessionOptionCatalog | null {
  return CATALOGS[agent] ?? null
}

export function findCatalogModel(
  catalog: AgentSessionOptionCatalog,
  modelId: string
): CatalogModel | undefined {
  return catalog.models.find((model) => model.id === modelId)
}

export function findCatalogOption(
  model: CatalogModel | undefined,
  optionId: string
): CatalogOption | undefined {
  return model?.options.find((option) => option.id === optionId)
}

export function catalogDefaultModel(catalog: AgentSessionOptionCatalog): CatalogModel | undefined {
  return catalog.models.find((model) => model.isDefault) ?? catalog.models[0]
}

export function catalogDefaultValues(model: CatalogModel): Record<string, SessionOptionValue> {
  return Object.fromEntries(model.options.map((option) => [option.id, option.kind.defaultValue]))
}

export function catalogModelFromDiscoveredCapability(
  agent: AgentType,
  model: CommitMessageModelCapability
): CatalogModel {
  return agent === 'codex'
    ? codexCatalogModelFromCapability(model)
    : { id: model.id, label: model.label, options: [] }
}

/** Merge live rows over the static seed while retaining only option shapes Orca
 * can actually map. A provider may mark its discovered option set authoritative
 * when the CLI reports per-model capabilities. */
export function mergeCatalogModels(
  seed: readonly CatalogModel[],
  discovered: readonly CatalogModel[]
): CatalogModel[] {
  const discoveredById = new Map(discovered.map((model) => [model.id, model]))
  const merged = seed.map((model) => {
    const live = discoveredById.get(model.id)
    if (!live) {
      return model
    }
    discoveredById.delete(model.id)
    return {
      ...model,
      ...live,
      options: live.optionsAuthoritative
        ? live.options
        : mergeOptionsById(model.options, live.options)
    }
  })
  return [...merged, ...discoveredById.values()]
}

// Why: when discovery is not authoritative (e.g. only a Fast tier was found
// but no effort levels), augment the seed options with discovered additions
// rather than silently dropping the seed effort picker.
function mergeOptionsById(
  seed: readonly CatalogOption[],
  discovered: readonly CatalogOption[]
): CatalogOption[] {
  const discoveredById = new Map(discovered.map((option) => [option.id, option]))
  const merged = seed.map((option) => {
    const live = discoveredById.get(option.id)
    if (!live) {
      return option
    }
    discoveredById.delete(option.id)
    return live
  })
  return [...merged, ...discoveredById.values()]
}

export function sessionOptionValueIsValid(value: unknown): value is SessionOptionValue {
  return typeof value === 'string' || typeof value === 'boolean'
}
