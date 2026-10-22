import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

// Why: the TUI's `/effort` usage lists none|minimal|low|medium|high|xhigh|max|ultra, and
// `muse model-profile show` reports default_reasoning_effort high for every catalog model.
const MUSE_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'none', label: 'None' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
      { value: 'ultra', label: 'Ultra' }
    ],
    defaultValue: 'high'
  },
  apply: {
    launchArgs: (value) => ['--reasoning-effort', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('muse', tokens, ['--reasoning-effort']),
    // Why: same shape as the claude-codex effort option — the pill dispatches
    // the slash command into the live PTY.
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

// Why: MSP `permissionProfile/list` returns these four built-ins with these labels and
// descriptions, and both `--permission-profile` and `session/setPermissionProfile` take the
// colon-prefixed id while rejecting the bare name. `/permissions` takes no argument — the
// bare command opens the TUI's own picker — so mid-session opens the agent picker the way
// Codex effort opens `/model`. Like Claude fast mode, there are no launch args: the CLI
// default comes from the user's own settings.json, and emitting a catalog default alongside
// a picked model would silently change the security posture of that launch.
const MUSE_PERMISSION_PROFILE: CatalogOption = {
  id: 'permissionProfile',
  label: 'Permissions',
  category: 'mode',
  kind: {
    type: 'select',
    choices: [
      { value: ':read-only', label: 'Read only', description: 'Reads files only.' },
      {
        value: ':ask-me',
        label: 'Ask me',
        description:
          'Edits workspace and temporary files; requires approval for protected writes, new network targets, and other restricted actions.'
      },
      {
        value: ':auto-review',
        label: 'Auto-review',
        description:
          'Same access as Ask me; AI reviews eligible actions; trusted permission hooks may decide approval requests first.'
      },
      {
        value: ':unrestricted',
        label: 'Unrestricted',
        description:
          'No filesystem sandbox or approval prompts; local commands have direct network access; project trust is unchanged.'
      }
    ],
    defaultValue: ':ask-me'
  },
  apply: {
    midSession: { kind: 'agent-picker', command: '/permissions', delivery: 'type' }
  }
}

const MUSE_MODEL_OPTIONS: CatalogOption[] = [MUSE_EFFORT, MUSE_PERMISSION_PROFILE]

export const MUSE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: MSP `model/list` (providerCatalog source) names these four models for the meta
  // provider, marking muse-wonder-1.0 the default. `isDefault` stays decorative — a
  // `model` key in the user's settings.json overrides the CLI default — so an untouched
  // draft never presents the seed as the launch's model.
  models: [
    {
      id: 'muse-wonder-1.0',
      label: 'Wonder 1.0',
      isDefault: true,
      options: MUSE_MODEL_OPTIONS
    },
    {
      id: 'muse-wonder-full-1.0',
      label: 'Wonder Full 1.0',
      options: MUSE_MODEL_OPTIONS
    },
    {
      id: 'muse-spark-1.3',
      label: 'Spark 1.3',
      options: MUSE_MODEL_OPTIONS
    },
    {
      id: 'muse-spark-1.2',
      label: 'Spark 1.2',
      options: MUSE_MODEL_OPTIONS
    }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('muse', tokens, ['--model']),
    // Why: `[<model-id>]/model` takes the id inline; a bare `/model` opens the TUI's own
    // picker, which the session surfaces like Claude's.
    midSession: {
      kind: 'command',
      build: (value) => `/model ${String(value)}`,
      pickerCommand: '/model'
    }
  },
  unknownModelOptions: MUSE_MODEL_OPTIONS
}
