import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'

// Why: the Claude CLI has no model-listing subcommand (`claude models` starts a
// chat session). One `list_models` control request over --print stream-json
// returns the CLI's /model picker catalog without starting an API turn. CLIs
// that predate the request answer `{"subtype":"error"}` and still exit 0, so
// parsing yields no models and callers keep their seed list.
export const CLAUDE_MODEL_LIST_STDIN = `${JSON.stringify({
  type: 'control_request',
  request_id: 'orca-model-discovery',
  request: { subtype: 'list_models' }
})}\n`

// Why: --print rejects stream-json output unless --verbose is also set.
export const CLAUDE_MODEL_LIST_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose'
]

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
  /** Model can use adaptive thinking budgets when the host CLI reports the flag (#13208). */
  supportsAdaptiveThinking: boolean
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
  supportsAdaptiveThinking?: unknown
}

function toListedModel(value: unknown): ClaudeListedModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const raw = value as RawListedModel
  const id = typeof raw.value === 'string' ? raw.value.trim() : ''
  if (!id) {
    return null
  }
  const label = typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : id
  let description =
    typeof raw.description === 'string' && raw.description.trim() ? raw.description : undefined
  const effortLevels =
    raw.supportsEffort === true && Array.isArray(raw.supportedEffortLevels)
      ? raw.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
      : []
  const supportsAdaptiveThinking = raw.supportsAdaptiveThinking === true
  // Why: the catalog previously dropped this flag entirely (#13208); surface it
  // on the picker description so hosts that report it are not silent.
  if (supportsAdaptiveThinking && description && !/adaptive thinking/i.test(description)) {
    description = `${description} · Adaptive thinking`
  } else if (supportsAdaptiveThinking && !description) {
    description = 'Adaptive thinking'
  }
  return {
    id,
    label,
    ...(description ? { description } : {}),
    effortLevels,
    supportsFastMode: raw.supportsFastMode === true,
    supportsAdaptiveThinking
  }
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
    for (const entry of models) {
      const model = toListedModel(entry)
      // Why: the `default` row mirrors whichever entry it currently resolves
      // to; Orca's pickers manage their own default selection.
      if (!model || model.id === 'default' || seen.has(model.id)) {
        continue
      }
      seen.add(model.id)
      listed.push(model)
    }
    if (listed.length > 0) {
      return listed
    }
  }
  return []
}
