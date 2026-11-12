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
function supersededCodexModels(models: readonly ListedModel[]): (model: ListedModel) => boolean {
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
    return (
      !!own &&
      (compareVersions(newestInFamily.get(`${own.prefix}\0${own.family}`) ?? [], own.version) > 0 ||
        (newestMajor.get(own.prefix) ?? 0) > own.version[0])
    )
  }
}

// Proven by the row naming the versioned model it runs, or, where a saved list or older host
// dropped that, by a versioned row of the same family (opus beside claude-opus-5-5).
function coveredClaudeAliases(models: readonly ListedModel[]): (model: ListedModel) => boolean {
  const selfResolved = new Set<string>()
  const versionedFamilies = new Set<string>()
  for (const row of models) {
    if (row.resolvedModel === row.id) {
      selfResolved.add(row.id)
    }
    const versioned = CLAUDE_VERSIONED_ID.exec(row.id)
    if (versioned) {
      versionedFamilies.add(`${versioned[1]}${versioned[2] ?? ''}`)
    }
  }
  return (model) => {
    const resolved = model.resolvedModel
    if (resolved && resolved !== model.id) {
      return selfResolved.has(resolved)
    }
    const alias = CLAUDE_ALIAS_ID.exec(model.id)
    return !!alias && versionedFamilies.has(`${alias[1]}${alias[2] ?? ''}`)
  }
}

const NO_LEGACY: ReadonlySet<string> = new Set()
// Why weak and per list: native chat rebuilds its options on every streamed render; catalogs are replaced, never mutated.
const classified = new WeakMap<readonly ListedModel[], Map<string, ReadonlySet<string>>>()

/** Rows every model picker folds under More models; the default and unrecognized ids stay listed. */
export function legacyAgentModelIds(
  agent: string,
  models: readonly ListedModel[]
): ReadonlySet<string> {
  if ((agent !== 'claude' && agent !== 'codex') || models.length === 0) {
    return NO_LEGACY
  }
  const byAgent = classified.get(models) ?? new Map<string, ReadonlySet<string>>()
  const cached = byAgent.get(agent)
  if (cached) {
    return cached
  }
  const isLegacy = agent === 'claude' ? coveredClaudeAliases(models) : supersededCodexModels(models)
  const legacy = new Set<string>()
  for (const model of models) {
    if (!model.isDefault && isLegacy(model)) {
      legacy.add(model.id)
    }
  }
  byAgent.set(agent, legacy)
  classified.set(models, byAgent)
  return legacy
}
