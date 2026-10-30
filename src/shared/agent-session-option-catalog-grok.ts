import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { agentChoiceCliApply } from './agent-choice-cli-apply'
import { parseGrokModelList } from './grok-model-list-probe'

// Omit none (untranslated), minimal and max (never advertised by a grok menu) from the canonical effort ladder.
const GROK_EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' }
]

// Expose each model's advertised ceiling; grok merely warns on unsupported tiers.
function grokEffort(ceiling: 'high' | 'xhigh'): CatalogOption {
  const ceilingIndex = GROK_EFFORT_CHOICES.findIndex((choice) => choice.value === ceiling)
  return {
    // Keep effort: strict LaunchPreferences drops/rejects novel IDs at client/wire boundaries.
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: GROK_EFFORT_CHOICES.slice(0, ceilingIndex + 1),
      // Every grok model defaults to high; an untouched picker must not silently escalate.
      defaultValue: 'high'
    },
    apply: {
      ...agentChoiceCliApply(
        'grok',
        [
          {
            kind: 'value',
            names: ['--effort', '--reasoning-effort'],
            lift: 'separate-and-long-equals'
          }
        ],
        '--reasoning-effort'
      ),
      midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
    }
  }
}

// Private enrichment-gate parser; actual probes parse through agent-model-probe-spec.ts.
function parseGrokCatalogModels(stdout: string): CatalogModel[] {
  return parseGrokModelList(stdout).map((model) => ({ ...model, options: [] }))
}

export const GROK_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Account and model config scope access; seed verified models and discover the rest.
  models: [
    {
      id: 'grok-4.7',
      label: 'Grok 4.7',
      description: "xAI's latest frontier model",
      isDefault: true,
      options: [grokEffort('xhigh')]
    },
    {
      id: 'grok-4.6',
      label: 'Grok 4.6',
      description: "xAI's previous frontier model",
      options: [grokEffort('xhigh')]
    },
    {
      id: 'grok-4.5',
      label: 'Grok 4.5',
      description: 'An earlier xAI frontier model',
      options: [grokEffort('high')]
    }
  ],
  modelApply: {
    ...agentChoiceCliApply(
      'grok',
      [{ kind: 'value', names: ['-m', '--model'], lift: 'separate-and-long-equals' }],
      '-m'
    ),
    // agent-picker replaces the list and never persists a model, preventing -m emission.
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  },
  // Supply effort for IDs absent from the launch seed. Use the widest menu: unsupported tiers warn, withheld tiers are unreachable.
  unknownModelOptions: [grokEffort('xhigh')],
  // Authoritative discovery must retire stale IDs because grok fails launch on them.
  discoveredModelsAreAuthoritative: true,
  // Match the CLI's reported Default model and (default) row marker.
  defaultModelIsCliDefault: true,
  listModels: { command: 'grok models', parse: parseGrokCatalogModels }
}
