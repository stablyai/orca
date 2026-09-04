import type { CommitMessageModel, ThinkingLevel } from './commit-message-agent-spec'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { labelFromModelId } from './model-id-label'

export const POLYTOKEN_MODEL_LIST_ARGS = ['models', '--format', 'json'] as const

// Why: Polytoken's configured default is applied by omitting `--model`; the sentinel keeps
// that choice visible in the picker without naming a transient provider model.
export const POLYTOKEN_CONFIGURED_DEFAULT_MODEL_ID = 'polytoken:configured-default'
export const POLYTOKEN_CONFIGURED_DEFAULT_MODEL: CommitMessageModel = {
  id: POLYTOKEN_CONFIGURED_DEFAULT_MODEL_ID,
  label: 'Configured default'
}

// Why: `polytoken models --format json` is trusted-local but unbounded; cap the structure
// before JSON.parse so a runaway catalog cannot stall the main process.
const MODEL_LIST_LIMITS = { structuralTokens: 200_000, nestingDepth: 16 } as const
const MAX_MODEL_LIST_BYTES = 4 * 1024 * 1024
const MAX_MODELS = 500

const LEVEL_LABELS: Record<string, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readThinkingLevels(
  reasoning: unknown
): Pick<CommitMessageModel, 'thinkingLevels' | 'defaultThinkingLevel'> {
  const record = readRecord(reasoning)
  const rawLevels = Array.isArray(record?.levels) ? record.levels : []
  const levels: ThinkingLevel[] = []
  if (record?.can_disable === true) {
    levels.push({ id: 'none', label: LEVEL_LABELS.none })
  }
  for (const level of rawLevels) {
    if (
      typeof level === 'string' &&
      /^[a-z]+$/.test(level) &&
      !levels.some((entry) => entry.id === level)
    ) {
      levels.push({ id: level, label: LEVEL_LABELS[level] ?? labelFromModelId(level) })
    }
  }
  if (levels.length === 0) {
    return {}
  }
  const defaultLevel = typeof record?.default_level === 'string' ? record.default_level : undefined
  return {
    thinkingLevels: levels,
    defaultThinkingLevel: levels.some((entry) => entry.id === defaultLevel)
      ? defaultLevel
      : levels[0].id
  }
}

/** Parses `polytoken models --format json` into the source-control model picker shape.
 *  Malformed, oversized, or unexpected output yields an empty list rather than phantom models. */
export function parsePolytokenModelList(stdout: string): CommitMessageModel[] {
  const text = stdout.trim()
  if (text.length === 0 || text.length > MAX_MODEL_LIST_BYTES) {
    return []
  }
  let parsed: unknown
  try {
    assertJsonTextStructureWithinLimits(text, MODEL_LIST_LIMITS)
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const root = readRecord(parsed)
  if (!root || !Array.isArray(root.models)) {
    return []
  }
  const defaultModel = typeof root.default_model === 'string' ? root.default_model : null
  const models: CommitMessageModel[] = []
  const seen = new Set<string>()
  for (const entry of root.models) {
    const record = readRecord(entry)
    const name = typeof record?.name === 'string' ? record.name.trim() : ''
    if (!record || name.length === 0 || seen.has(name)) {
      continue
    }
    seen.add(name)
    models.push({
      id: name,
      label: name.includes('/')
        ? `${labelFromModelId(name.slice(0, name.indexOf('/')))} ${labelFromModelId(name.slice(name.indexOf('/') + 1))}`
        : labelFromModelId(name),
      ...(name === defaultModel || record.is_default === true ? { isDefault: true } : {}),
      ...readThinkingLevels(record.reasoning)
    })
    if (models.length >= MAX_MODELS) {
      break
    }
  }
  return models
}

// Why: Polytoken selects reasoning effort with the `name(level)` locator that `models` lists
// under `selectable`, so the effort rides inside the single `--model` value.
export function buildPolytokenModelArg(model: string, thinkingLevel?: string): string {
  return thinkingLevel ? `${model}(${thinkingLevel})` : model
}
