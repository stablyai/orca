type ListedModel = { id: string; resolvedModel?: string | null; isDefault?: boolean }

const VERSIONED_MODEL_ID = /^([a-z]+)-(\d+(?:\.\d+)*)(?:-([a-z][a-z0-9-]*))?$/
const CLAUDE_ALIAS_ID = /^([a-z]+)(\[1m\])?$/
const CLAUDE_VERSIONED_ID = /^claude-([a-z]+)-\d[\d-]*(\[1m\])?$/

type VersionedModelId = { prefix: string; version: number[]; family: string }

function versionedModelId(id: string): VersionedModelId | null {
  const match = VERSIONED_MODEL_ID.exec(id)
  return match
    ? { prefix: match[1], version: match[2].split('.').map(Number), family: match[3] ?? '' }
    : null
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

// Superseded within its family (6-sol by 6.1-sol), or from an older major line than the newest listed.
// Why one pass: native chat reclassifies on every streamed render.
function supersededCodexModels(models: readonly ListedModel[]): (model: ListedModel) => ModelClass {
  const parsed = new Map<string, VersionedModelId>()
  const newestInFamily = new Map<string, number[]>()
  const newestMajor = new Map<string, number>()
  for (const { id } of models) {
    const own = versionedModelId(id)
    if (!own) {
      continue
    }
    parsed.set(id, own)
    const family = `${own.prefix}\0${own.family}`
    const newest = newestInFamily.get(family)
    if (!newest || compareVersions(own.version, newest) > 0) {
      newestInFamily.set(family, own.version)
    }
    newestMajor.set(own.prefix, Math.max(newestMajor.get(own.prefix) ?? 0, own.version[0]))
  }
  return ({ id }) => {
    const own = parsed.get(id)
    return own &&
      (compareVersions(newestInFamily.get(`${own.prefix}\0${own.family}`) ?? [], own.version) > 0 ||
        (newestMajor.get(own.prefix) ?? 0) > own.version[0])
      ? 'legacy'
      : null
  }
}

// Proven by the row naming the versioned model it runs, or, where a saved list or older host
// dropped that, by a versioned row of the same family (opus beside claude-opus-5-5). Only a
// family short name (opus, opus[1m]) is that model; other names (opusplan) only fold.
function coveredClaudeAliases(models: readonly ListedModel[]): (model: ListedModel) => ModelClass {
  const selfResolved = new Set<string>()
  const versionedFamilies = new Set<string>()
  for (const row of models) {
    if (row.resolvedModel === row.id) {
      selfResolved.add(row.id)
    }
    const family = claudeVersionedFamily(row.id)
    if (family) {
      versionedFamilies.add(family)
    }
  }
  return (model) => {
    const alias = CLAUDE_ALIAS_ID.exec(model.id)
    const family = alias ? `${alias[1]}${alias[2] ?? ''}` : null
    const resolved = model.resolvedModel
    if (resolved && resolved !== model.id) {
      if (!selfResolved.has(resolved)) {
        return null
      }
      return family && claudeVersionedFamily(resolved) === family ? 'hidden' : 'legacy'
    }
    return family && versionedFamilies.has(family) ? 'hidden' : null
  }
}

function claudeVersionedFamily(id: string): string | null {
  const versioned = CLAUDE_VERSIONED_ID.exec(id)
  return versioned ? `${versioned[1]}${versioned[2] ?? ''}` : null
}

type ModelClass = 'legacy' | 'hidden' | null

/** Rows pickers fold under More models, and rows they list only while one is the current choice. */
export type AgentModelClasses = { legacy: ReadonlySet<string>; hidden: ReadonlySet<string> }

const NONE: AgentModelClasses = { legacy: new Set(), hidden: new Set() }
// Why weak and per list: native chat reclassifies on every streamed render; catalogs are replaced, never mutated.
const classified = new WeakMap<readonly ListedModel[], Map<string, AgentModelClasses>>()

/** The default and unrecognized ids are never folded or hidden. */
export function classifyAgentModels(
  agent: string,
  models: readonly ListedModel[]
): AgentModelClasses {
  if ((agent !== 'claude' && agent !== 'codex') || models.length === 0) {
    return NONE
  }
  const byAgent = classified.get(models) ?? new Map<string, AgentModelClasses>()
  const cached = byAgent.get(agent)
  if (cached) {
    return cached
  }
  const classOf = agent === 'claude' ? coveredClaudeAliases(models) : supersededCodexModels(models)
  const classes = { legacy: new Set<string>(), hidden: new Set<string>() }
  for (const model of models) {
    const modelClass = model.isDefault ? null : classOf(model)
    if (modelClass) {
      classes[modelClass].add(model.id)
    }
  }
  byAgent.set(agent, classes)
  classified.set(models, byAgent)
  return classes
}
