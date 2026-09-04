import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'

function parseOpenCodeModels(stdout: string): CatalogModel[] {
  const seen = new Set<string>()
  return stdout.split(/\r?\n/).flatMap((line) => {
    const id = line.trim()
    const slash = id.indexOf('/')
    // Why: OpenCode splits on the first `/`; model_id may contain `/` and `@`.
    if (slash <= 0 || slash === id.length - 1 || /\s/.test(id) || seen.has(id)) {
      return []
    }
    seen.add(id)
    return [{ id, label: id, options: [] }]
  })
}

export const OPENCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: the TUI accepts `--model` but not `--variant` (`opencode run` only), so
  // worker `--effort` must stay rejected until a launch-time TUI flag exists.
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model'])
  },
  listModels: { command: 'opencode models', parse: parseOpenCodeModels }
}
