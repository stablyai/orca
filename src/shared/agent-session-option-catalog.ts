import { CODEBUDDY_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-codebuddy'
import type { AgentType } from './agent-status-types'
import { ANTIGRAVITY_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-antigravity'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG,
  createClaudeCatalogOptions
} from './agent-session-option-catalog-claude-codex'
import {
  CURSOR_SESSION_OPTION_CATALOG,
  GEMINI_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-gemini-cursor'
import { GROK_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-grok'
import { MUSE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-muse'
import { OMP_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-omp'
import type {
  AgentSessionOptionCatalog,
  AgentSessionOptionCatalogMap,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import type { SessionOptionValue } from './native-chat-session-options'

export type {
  AgentSessionOptionCatalog,
  CatalogAgentInteractionDetection,
  CatalogCommandDelivery,
  CatalogMidSessionApply,
  CatalogModel,
  CatalogOption,
  CatalogOptionApply
} from './agent-session-option-catalog-types'
export { createClaudeCatalogOptions }

const CATALOGS: AgentSessionOptionCatalogMap = {
  antigravity: ANTIGRAVITY_SESSION_OPTION_CATALOG,
  claude: CLAUDE_SESSION_OPTION_CATALOG,
  codebuddy: CODEBUDDY_SESSION_OPTION_CATALOG,
  codex: CODEX_SESSION_OPTION_CATALOG,
  gemini: GEMINI_SESSION_OPTION_CATALOG,
  cursor: CURSOR_SESSION_OPTION_CATALOG,
  grok: GROK_SESSION_OPTION_CATALOG,
  muse: MUSE_SESSION_OPTION_CATALOG,
  omp: OMP_SESSION_OPTION_CATALOG
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

/** Merge live rows over the static seed while retaining cataloged option mappings. */
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
    return { ...model, ...live, options: model.options }
  })
  return [...merged, ...discoveredById.values()]
}

/** Discovery controls membership; retain seed option menus. Unseeded models inherit default-seed global CLI flags so their picker stays available. */
export function mergeDiscoveredAuthoritativeModels(
  seed: readonly CatalogModel[],
  discovered: readonly CatalogModel[]
): CatalogModel[] {
  const inheritedOptions = (seed.find((model) => model.isDefault) ?? seed[0])?.options ?? []
  return discovered.map((disc) => {
    const seedMatch = seed.find((model) => model.id === disc.id)
    const { isDefault: _seeded, ...merged } = seedMatch
      ? { ...seedMatch, ...disc, options: seedMatch.options }
      : { ...disc, options: inheritedOptions }
    // Use the probe's current CLI default; a release-frozen seed mislabels changed account defaults.
    return disc.isDefault ? { ...merged, isDefault: true } : merged
  })
}

export function sessionOptionValueIsValid(value: unknown): value is SessionOptionValue {
  return typeof value === 'string' || typeof value === 'boolean'
}
