import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { PI_THINKING_LEVELS, parsePiModelTableRow } from './pi-model-list-probe'

const PI_THINKING: CatalogOption = {
  id: 'effort',
  label: 'Thinking',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: PI_THINKING_LEVELS.map((level) => ({
      value: level.id,
      label: level.label
    })),
    defaultValue: 'medium'
  },
  apply: {
    launchArgs: (value) => ['--thinking', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--thinking']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--thinking'])
  }
}

function parsePiModels(stdout: string): CatalogModel[] {
  const seen = new Set<string>()
  return stdout.split(/\r?\n/).flatMap((line) => {
    const row = parsePiModelTableRow(line)
    if (!row) {
      return []
    }
    const id = `${row.provider}/${row.model}`
    if (seen.has(id)) {
      return []
    }
    seen.add(id)
    return [{ id, label: id, options: [] }]
  })
}

export const PI_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: Pi's TUI accepts `--model provider/id` and `--thinking` at launch, so
  // worker `--effort` maps to `--thinking` instead of being composed into the id.
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model'])
  },
  unknownModelOptions: [PI_THINKING],
  listModels: { command: 'pi --list-models', parse: parsePiModels }
}
