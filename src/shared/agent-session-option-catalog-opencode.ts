import { hasFlag } from './agent-cli-flag-detection'
import { parseLineModels } from './commit-message-agent-spec'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'

// OpenCode's model surface is provider-based (`opencode models` lists whatever
// the host configured — the opencode gateway, OpenRouter, GitHub Copilot, …),
// so the seed mirrors the commit-message registry's verified pair and discovery
// supplies the rest. `opencode -m <provider/model>` is verified CLI surface.

// The enrichment gate reads only `listModels`' presence; the probe itself parses
// through `agent-model-probe-spec.ts` → the commit-message registry's
// `parseLineModels` (one `provider/model` id per line), so reuse it here.
function parseOpenCodeCatalogModels(stdout: string): CatalogModel[] {
  return parseLineModels(stdout).map((model) => ({ ...model, options: [] }))
}

// Why: every model ships `options: []` deliberately. Unlike claude/codex/grok,
// OpenCode's verified CLI surface has no effort/thinking launch flag — reasoning
// is configured per provider in OpenCode's own config, and the TUI `/thinking`
// command only toggles reasoning block visibility. The commit-message registry
// can still set thinking because it talks to models directly; a session launch
// must not synthesize an option it cannot apply on OpenCode's behalf.

export const OPENCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: mirrors the commit-message registry's seed — the free gateway model
  // works out of the box (hosted GPT models can require workspace billing), and
  // discovery replaces the list because available models are host-dependent.
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
    // Why: OpenCode has no argument-taking `/model` TUI command — `/models`
    // opens the CLI's own interactive picker, exactly like Codex's `/model`.
    // `agent-picker` types the command instead of asserting a value orca cannot
    // apply on OpenCode's behalf.
    midSession: { kind: 'agent-picker', command: '/models', delivery: 'type' }
  },
  // Why: a seed id the host's providers do not carry is a fatal launch, so a
  // successful probe must be able to retire it.
  discoveredModelsAreAuthoritative: true,
  listModels: { command: 'opencode models', parse: parseOpenCodeCatalogModels }
}
