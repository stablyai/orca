import { hasFlag } from './agent-cli-flag-detection'
import { parseLineModels } from './commit-message-agent-spec'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'

// Provider-based model surface: seed the verified pair; discovery supplies the rest.

// The probe emits one provider/model id per line — reuse the registry's parser.
function parseOpenCodeCatalogModels(stdout: string): CatalogModel[] {
  return parseLineModels(stdout).map((model) => ({ ...model, options: [] }))
}

// Why: OpenCode's CLI has no effort/thinking launch flag — never synthesize one.

export const OPENCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: the free gateway model works out of the box; discovery replaces the seed.
  models: [
    {
      id: 'opencode/deepseek-v4-flash-free',
      label: 'OpenCode DeepSeek V4 Flash Free',
      isDefault: true,
      options: []
    },
    {
      id: 'opencode/gpt-5.4-mini',
      label: 'OpenCode GPT 5.4 Mini',
      options: []
    }
  ],
  modelApply: {
    // Verified: `opencode --help` documents `-m, --model  model to use in the
    // format of provider/model`.
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    // Why: `/models` opens OpenCode's own picker — type it, don't assert a value.
    midSession: { kind: 'agent-picker', command: '/models', delivery: 'type' }
  },
  // Why: a seed id the host's providers do not carry is a fatal launch, so a
  // successful probe must be able to retire it.
  discoveredModelsAreAuthoritative: true,
  listModels: { command: 'opencode models', parse: parseOpenCodeCatalogModels }
}
