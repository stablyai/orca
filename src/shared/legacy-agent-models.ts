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
function isSupersededCodexModel(id: string, models: readonly ListedModel[]): boolean {
  const own = versionedModelId(id)
  if (!own) {
    return false
  }
  return models.some((row) => {
    const other = versionedModelId(row.id)
    if (!other || other.prefix !== own.prefix) {
      return false
    }
    return other.family === own.family
      ? compareVersions(other.version, own.version) > 0
      : other.version[0] > own.version[0]
  })
}

// Proven by the row naming the versioned model it runs, or, where a saved list or older host
// dropped that, by a versioned row of the same family (opus beside claude-opus-5-5).
function isCoveredClaudeAlias(model: ListedModel, models: readonly ListedModel[]): boolean {
  const resolved = model.resolvedModel
  if (resolved && resolved !== model.id) {
    return models.some((row) => row.id === resolved && row.resolvedModel === resolved)
  }
  const alias = CLAUDE_ALIAS_ID.exec(model.id)
  return (
    !!alias &&
    models.some((row) => {
      const versioned = CLAUDE_VERSIONED_ID.exec(row.id)
      return !!versioned && versioned[1] === alias[1] && versioned[2] === alias[2]
    })
  )
}

/** Rows every model picker folds under Legacy models; the default and unrecognized ids stay listed. */
export function legacyAgentModelIds(agent: string, models: readonly ListedModel[]): Set<string> {
  const legacy = new Set<string>()
  if (agent !== 'claude' && agent !== 'codex') {
    return legacy
  }
  for (const model of models) {
    if (
      !model.isDefault &&
      (agent === 'claude'
        ? isCoveredClaudeAlias(model, models)
        : isSupersededCodexModel(model.id, models))
    ) {
      legacy.add(model.id)
    }
  }
  return legacy
}
