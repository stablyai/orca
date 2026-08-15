import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'

export const CODEX_MODEL_LIST_ARGS = ['debug', 'models'] as const
export const CODEX_MODEL_LIST_COMMAND = `codex ${CODEX_MODEL_LIST_ARGS.join(' ')}`
export const CODEX_MODEL_LIST_MAX_JSON_CHARACTERS = 4 * 1024 * 1024

export const CODEX_MODEL_LIST_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 64 * 1024,
  nestingDepth: 16
} as const

export type CodexModelListModel = {
  id: string
  label: string
  effortLevels: string[]
  defaultEffort: string | null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  return value.trim() || null
}

function uniqueEffortLevels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const levels: string[] = []
  for (const entry of value) {
    const effort =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? nonEmptyString((entry as { effort?: unknown }).effort)
        : null
    if (effort && !seen.has(effort)) {
      seen.add(effort)
      levels.push(effort)
    }
  }
  return levels
}

export function parseCodexModelList(stdout: string): CodexModelListModel[] {
  try {
    if (stdout.length > CODEX_MODEL_LIST_MAX_JSON_CHARACTERS) {
      return []
    }
    assertJsonTextStructureWithinLimits(stdout, CODEX_MODEL_LIST_JSON_STRUCTURE_LIMITS)
    const parsed: unknown = JSON.parse(stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return []
    }
    const models = (parsed as { models?: unknown }).models
    if (!Array.isArray(models)) {
      return []
    }

    const seen = new Set<string>()
    const result: CodexModelListModel[] = []
    for (const value of models) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue
      }
      const model = value as Record<string, unknown>
      const id = nonEmptyString(model.slug)
      const label = nonEmptyString(model.display_name)
      if (!id || !label || seen.has(id)) {
        continue
      }
      seen.add(id)
      result.push({
        id,
        label,
        effortLevels: uniqueEffortLevels(model.supported_reasoning_levels),
        defaultEffort: nonEmptyString(model.default_reasoning_level)
      })
    }
    return result
  } catch {
    return []
  }
}
