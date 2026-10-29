import { claudeBackgroundArgs } from './claude-background-run-isolation'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'

// claude models starts chat; list_models over --print stream-json reads the picker without an API turn. Older CLIs return error with exit 0; keep seed models.
export const CLAUDE_MODEL_LIST_STDIN = `${JSON.stringify({
  type: 'control_request',
  request_id: 'orca-model-discovery',
  request: { subtype: 'list_models' }
})}\n`

// --print stream-json requires --verbose.
export function buildClaudeModelListArgs(
  strictMcp = true,
  userArgs: readonly string[] = []
): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    ...claudeBackgroundArgs(strictMcp, userArgs)
  ]
}

export const CLAUDE_MODEL_LIST_ARGS = buildClaudeModelListArgs()

export type ClaudeListedModel = {
  /** Value the CLI accepts for `--model` and `/model` (e.g. `opus[1m]`). */
  id: string
  /** The CLI's own picker label (e.g. `Opus (1M context)`). */
  label: string
  /** Names what the value resolves to on this host (e.g. `Opus 5 with 1M context …`). */
  description?: string
  /** `--effort` values this model accepts; empty when it has no effort control. */
  effortLevels: string[]
  supportsFastMode: boolean
  /** Absent when the CLI predates the field: unknown, never unsupported. */
  supportsAutoMode?: boolean
  /** Runs what the CLI's `default` row resolves to: what a chat that names no model runs. */
  isDefault?: true
}

const CLAUDE_MODEL_LIST_JSON_LIMITS = {
  structuralTokens: 64 * 1024,
  nestingDepth: 16
} as const

type RawControlResponse = {
  type?: unknown
  response?: {
    subtype?: unknown
    response?: { models?: unknown }
  }
}

type RawListedModel = {
  value?: unknown
  displayName?: unknown
  description?: unknown
  supportsEffort?: unknown
  supportedEffortLevels?: unknown
  supportsFastMode?: unknown
  supportsAutoMode?: unknown
  disabled?: unknown
}

function toListedModel(value: unknown): ClaudeListedModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const raw = value as RawListedModel
  const id = typeof raw.value === 'string' ? raw.value.trim() : ''
  // Drop disabled placeholders (e.g. cc-update-required-1) before they can reach --model.
  if (!id || raw.disabled === true) {
    return null
  }
  const label = typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : id
  const description =
    typeof raw.description === 'string' && raw.description.trim() ? raw.description : undefined
  const effortLevels =
    raw.supportsEffort === true && Array.isArray(raw.supportedEffortLevels)
      ? raw.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
      : []
  return {
    id,
    label,
    ...(description ? { description } : {}),
    effortLevels,
    supportsFastMode: raw.supportsFastMode === true,
    ...(typeof raw.supportsAutoMode === 'boolean' ? { supportsAutoMode: raw.supportsAutoMode } : {})
  }
}

function valueOf(entry: unknown): unknown {
  return entry && typeof entry === 'object' && 'value' in entry ? entry.value : undefined
}

function resolvedModelOf(entry: unknown): string | null {
  const resolved =
    entry && typeof entry === 'object' && 'resolvedModel' in entry ? entry.resolvedModel : undefined
  return typeof resolved === 'string' && resolved.trim() ? resolved : null
}

export function parseClaudeModelList(stdout: string): ClaudeListedModel[] {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('{') || !line.includes('control_response')) {
      continue
    }
    let parsed: RawControlResponse
    try {
      assertJsonTextStructureWithinLimits(line, CLAUDE_MODEL_LIST_JSON_LIMITS)
      parsed = JSON.parse(line) as RawControlResponse
    } catch {
      continue
    }
    if (parsed.type !== 'control_response' || parsed.response?.subtype !== 'success') {
      continue
    }
    const models = parsed.response.response?.models
    if (!Array.isArray(models)) {
      continue
    }
    const seen = new Set<string>()
    const listed: ClaudeListedModel[] = []
    const defaultRuns = resolvedModelOf(models.find((entry) => valueOf(entry) === 'default'))
    for (const entry of models) {
      const model = toListedModel(entry)
      // Mark the real model resolved by default; do not publish a duplicate default row.
      if (!model || model.id === 'default' || seen.has(model.id)) {
        continue
      }
      seen.add(model.id)
      const runsDefault = defaultRuns !== null && resolvedModelOf(entry) === defaultRuns
      listed.push(runsDefault ? { ...model, isDefault: true } : model)
    }
    if (listed.length > 0) {
      return listed
    }
  }
  return []
}
