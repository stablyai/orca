import type { AgentType } from './agent-status-types'
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
  claude: CLAUDE_SESSION_OPTION_CATALOG,
  codex: CODEX_SESSION_OPTION_CATALOG,
  gemini: GEMINI_SESSION_OPTION_CATALOG,
  cursor: CURSOR_SESSION_OPTION_CATALOG,
  grok: GROK_SESSION_OPTION_CATALOG
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

/** Discovery decides membership; the seed keeps its option menus, which discovery never carries.
 *  Why: an unseeded model inherits the default seed's options because these catalogs' options are
 *  global CLI flags, not per-model capabilities — dropping them would hide the picker entirely. */
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
    // Why: the probe reports which id the CLI defaults to today; a seed flag frozen at
    // release would keep naming the old one after the account's default moves.
    return disc.isDefault ? { ...merged, isDefault: true } : merged
  })
}

/**
 * Whether a host's CLI-probe answer REPLACES the seed's membership or merely extends it.
 *
 * Its scope is CLI-probe membership only — what `listModels` stdout claims. A probe that merely
 * extends is, by construction, not a complete list — the Codex catalog says so of itself — so
 * nothing may be refused against it. Both the picker's merge below and `worker-start`'s reject
 * gate read this, so what is offered and what is accepted cannot drift apart.
 *
 * A live session's own model list is a DIFFERENT authority, outside this function's scope: Codex's
 * app-server `model/list` and Claude's SDK `supportedModels()` each speak for one connected
 * session and already decide their own membership. Routing either through here would hand it the
 * extend-only verdict and delete a rejection that exists today — see
 * `applyValidatedCodexStructuredSessionOption`.
 */
export function discoveredModelsReplaceSeed(
  agent: AgentType,
  catalog: AgentSessionOptionCatalog
): boolean {
  return agent === 'claude' || catalog.discoveredModelsAreAuthoritative === true
}

/**
 * The models a host's probe answer offers for `agent`: Claude's list replaces the seed outright,
 * an authoritative list decides membership while keeping seeded option menus, and a list that only
 * extends unions with the seed.
 */
export function resolveDiscoveredCatalogModels(
  agent: AgentType,
  catalog: AgentSessionOptionCatalog,
  discovered: readonly CatalogModel[]
): CatalogModel[] {
  if (!discoveredModelsReplaceSeed(agent, catalog)) {
    return mergeCatalogModels(catalog.models, discovered)
  }
  return agent === 'claude'
    ? [...discovered]
    : mergeDiscoveredAuthoritativeModels(catalog.models, discovered)
}

export function sessionOptionValueIsValid(value: unknown): value is SessionOptionValue {
  return typeof value === 'string' || typeof value === 'boolean'
}
