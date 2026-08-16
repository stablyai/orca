import { hasFlag } from './agent-cli-flag-detection'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { parseGrokModelList } from './grok-model-list-probe'

// The offered slice of grok's canonical ladder, low to high. Its `none` tier is
// omitted because `native-chat-session-option-labels.ts` leaves it untranslated;
// `minimal` and `max` because no grok model's menu has ever advertised them.
const GROK_EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' }
]

// Why: grok accepts only the tiers the model's own menu advertises and merely warns
// on the rest, so expose each model's ceiling rather than one shared menu.
function grokEffort(ceiling: 'high' | 'xhigh'): CatalogOption {
  const ceilingIndex = GROK_EFFORT_CHOICES.findIndex((choice) => choice.value === ceiling)
  return {
    // Why: `LaunchPreferences` is a strict zod object over model/effort/mode, so a
    // novel id is dropped client-side and rejected on the wire.
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: GROK_EFFORT_CHOICES.slice(0, ceilingIndex + 1),
      // Why: every grok model reports `reasoning_effort: "high"` as its own default,
      // so an untouched picker must not silently escalate past it.
      defaultValue: 'high'
    },
    apply: {
      launchArgs: (value) => ['--reasoning-effort', String(value)],
      agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort', '--reasoning-effort']),
      midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
    }
  }
}

// The enrichment gate reads only `listModels`' presence; the probe itself parses
// through `agent-model-probe-spec.ts`, so keep this private to that gate.
function parseGrokCatalogModels(stdout: string): CatalogModel[] {
  return parseGrokModelList(stdout).map((model) => ({ ...model, options: [] }))
}

export const GROK_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: Grok model access depends on the signed-in account and on [model.*]
  // config. Seed only what is verified; discovery supplies the rest.
  models: [
    {
      id: 'grok-4.6',
      label: 'Grok 4.6',
      description: "xAI's latest frontier model",
      isDefault: true,
      options: [grokEffort('xhigh')]
    },
    {
      id: 'grok-4.5',
      label: 'Grok 4.5',
      description: "xAI's previous frontier model",
      options: [grokEffort('high')]
    }
  ],
  modelApply: {
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    // Why: `agent-picker` would replace the whole model list with "Choose in
    // agent picker…" and never persist a model, so `-m` would never be emitted.
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  },
  // Why: launch resolves against this static seed, so without it a discovered id the
  // seed does not carry shows the effort menu but launches with the flag dropped. The
  // widest menu is the safe guess: grok warns on a tier a model lacks, but a tier the
  // menu withholds is unreachable.
  unknownModelOptions: [grokEffort('xhigh')],
  // Why: grok's selectable ids retire between releases, so a stale seed entry
  // must be droppable — picking one is a fatal launch, not a warning.
  discoveredModelsAreAuthoritative: true,
  // Why: `grok models` prints `Default model: grok-4.6` and marks the row `(default)`,
  // so the seed states the CLI's own choice rather than a preference of ours.
  defaultModelIsCliDefault: true,
  listModels: { command: 'grok models', parse: parseGrokCatalogModels }
}
