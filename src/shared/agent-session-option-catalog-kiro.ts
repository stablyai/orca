import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { kiroAgentEngineArgs } from './kiro-cli-engine'

export const KIRO_MODEL_LIST_COMMAND = 'kiro-cli chat --list-models --format json'

const ENGINE_FLAGS = ['--agent-engine', '--v1', '--v2', '--v3', '--mode']

/**
 * Engine choice, carried on the `mode` option because launch preferences are a
 * strict model/effort/mode object — a novel id is dropped client-side.
 *
 * The default emits no flag on purpose: 2.x runs v2 and 3.0 runs v3, so naming
 * either one here would override the installed CLI's own migration. Spec mode
 * is v3-only, which is why it is a compound choice rather than its own option.
 */
const KIRO_ENGINE: CatalogOption = {
  id: 'mode',
  label: 'Agent engine',
  category: 'mode',
  kind: {
    type: 'select',
    choices: [
      { value: 'default', label: 'CLI default' },
      { value: 'v2', label: 'V2 engine' },
      { value: 'v3', label: 'V3 agent' },
      { value: 'v3-spec', label: 'V3 agent (spec mode)' }
    ],
    defaultValue: 'default'
  },
  apply: {
    launchArgs: (value) => {
      if (value === 'v2' || value === 'v3') {
        return kiroAgentEngineArgs(value)
      }
      if (value === 'v3-spec') {
        return [...kiroAgentEngineArgs('v3'), '--mode', 'spec']
      }
      return []
    },
    agentArgsOverride: (tokens) => hasFlag(tokens, ENGINE_FLAGS),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--agent-engine', '--mode']),
    // The engine is chosen when the process starts; no slash command moves it.
    midSession: { kind: 'unsupported' }
  }
}

const KIRO_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'default', label: 'CLI default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' }
    ],
    // Why the default emits nothing: `--effort` is a session override that beats
    // the `chat.modelDefaults` effort saved in cli.json. Sending a level the user
    // never picked would silently discard their own saved preference.
    defaultValue: 'default',
    defaultIsCliDefault: true
  },
  apply: {
    launchArgs: (value) => (value === 'default' ? [] : ['--effort', String(value)]),
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--effort']),
    midSession: { kind: 'unsupported' }
  }
}

const KIRO_OPTIONS = [KIRO_ENGINE, KIRO_EFFORT]

type KiroModelListEntry = {
  model_id?: unknown
  model_name?: unknown
  description?: unknown
  rate_multiplier?: unknown
  rate_unit?: unknown
}

function modelLabel(entry: KiroModelListEntry, id: string): string {
  const name = typeof entry.model_name === 'string' ? entry.model_name.trim() : ''
  return name.length > 0 ? name : id
}

// Why surfaced: Kiro bills the plan meter per credit, and the multiplier is the
// only thing that tells a 0.05x model from a 4.4x one before the run starts.
function modelDescription(entry: KiroModelListEntry): string | undefined {
  const description = typeof entry.description === 'string' ? entry.description.trim() : ''
  const multiplier = typeof entry.rate_multiplier === 'number' ? entry.rate_multiplier : null
  if (multiplier === null) {
    return description.length > 0 ? description : undefined
  }
  const unit =
    typeof entry.rate_unit === 'string' && entry.rate_unit.trim().length > 0
      ? entry.rate_unit.trim()
      : 'Credit'
  const rate = `${multiplier}x ${unit}`
  return description.length > 0 ? `${description} · ${rate}` : rate
}

/** Parses `kiro-cli chat --list-models --format json`; returns [] on any surprise. */
export function parseKiroModelList(stdout: string): CatalogModel[] {
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    return []
  }
  if (typeof payload !== 'object' || payload === null) {
    return []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the two keys are read back as `unknown`, so this only names them, it does not claim their types.
  const { models, default_model: defaultModel } = payload as {
    models?: unknown
    default_model?: unknown
  }
  if (!Array.isArray(models)) {
    return []
  }
  const parsed: CatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of models) {
    if (typeof raw !== 'object' || raw === null) {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field of KiroModelListEntry is `unknown` and re-checked below; the cast only names them.
    const entry = raw as KiroModelListEntry
    const id = typeof entry.model_id === 'string' ? entry.model_id.trim() : ''
    if (id.length === 0 || seen.has(id)) {
      continue
    }
    seen.add(id)
    const description = modelDescription(entry)
    parsed.push({
      id,
      label: modelLabel(entry, id),
      ...(description ? { description } : {}),
      ...(id === defaultModel ? { isDefault: true } : {}),
      options: KIRO_OPTIONS
    })
  }
  return parsed
}

export const KIRO_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why one seed row: the model list is account- and region-dependent, and
  // `auto` is the only id the CLI itself names as its default. Discovery
  // supplies the rest, and retires ids this seed would otherwise outlive.
  models: [
    {
      id: 'auto',
      label: 'Auto',
      description: 'Models chosen by task for optimal usage and consistent quality',
      isDefault: true,
      options: KIRO_OPTIONS
    }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model']),
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  unknownModelOptions: KIRO_OPTIONS,
  discoveredModelsAreAuthoritative: true,
  // `--list-models` reports `default_model`, so the marked row is the CLI's own.
  defaultModelIsCliDefault: true,
  listModels: { command: KIRO_MODEL_LIST_COMMAND, parse: parseKiroModelList }
}
