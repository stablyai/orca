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
  /** Absent on older CLI dumps; treat missing as listed. */
  visibility: string | null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  return value.trim() || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function uniqueEffortLevels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const levels: string[] = []
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue
    }
    const effort = nonEmptyString(entry.effort)
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
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
      return []
    }

    const seen = new Set<string>()
    const result: CodexModelListModel[] = []
    for (const value of parsed.models) {
      if (!isRecord(value)) {
        continue
      }
      const id = nonEmptyString(value.slug)
      const label = nonEmptyString(value.display_name)
      if (!id || !label || seen.has(id)) {
        continue
      }
      seen.add(id)
      result.push({
        id,
        label,
        effortLevels: uniqueEffortLevels(value.supported_reasoning_levels),
        defaultEffort: nonEmptyString(value.default_reasoning_level),
        visibility: nonEmptyString(value.visibility)
      })
    }
    return result
  } catch {
    return []
  }
}
