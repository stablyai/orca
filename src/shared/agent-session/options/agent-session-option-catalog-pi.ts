import { agentChoiceCliApply } from '../../agent-launch/choices/agent-choice-cli-apply'
import { PI_THINKING_LEVELS } from './structured-agent-session-effective-effort'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

const PI_THINKING_LABELS: Readonly<Record<string, string>> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

// Pi names the effort flag `--thinking`; its seven levels are the ones `pi --help` lists.
const PI_THINKING: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: PI_THINKING_LEVELS.map((level) => ({
      value: level,
      label: PI_THINKING_LABELS[level] ?? level
    })),
    defaultValue: 'medium'
  },
  apply: {
    ...agentChoiceCliApply(
      'pi',
      [{ kind: 'value', names: ['--thinking'], lift: 'separate-and-long-equals' }],
      '--thinking'
    ),
    // Pi's own /thinking accepts an exact level; anything else opens its selector.
    midSession: { kind: 'command', build: (value) => `/thinking ${String(value)}` }
  }
}

export const PI_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Pi's models are whatever its configured providers offer; seed none and let the probe name them.
  models: [],
  modelApply: {
    // `--model` reads `provider/id`, optionally suffixed with `:thinking`.
    ...agentChoiceCliApply(
      'pi',
      [{ kind: 'value', names: ['--model'], lift: 'separate-and-long-equals' }],
      '--model'
    ),
    // `/model <provider/id>` selects an exact model; a non-matching term opens pi's selector.
    midSession: {
      kind: 'command',
      build: (value) => `/model ${String(value)}`,
      pickerCommand: '/model'
    }
  },
  // Pi resolves `--model` only among the provider `--provider` names, so a stale pin reads the
  // picked id as another provider's custom model.
  argsReplacedWithModel: ['--provider'],
  // Account-scoped provider ids never appear in a seed, so effort rides every listed model.
  unknownModelOptions: [PI_THINKING]
}
