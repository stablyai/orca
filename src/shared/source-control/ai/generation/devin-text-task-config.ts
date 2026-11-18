import { generationArgumentText, type GenerationArgument } from './generation-argument'

// Devin's print mode has no tool-disable flag; a --config override carrying deny rules is the only
// tool isolation it accepts. Deny rules still apply under a dangerous permission mode, and project
// allow rules cannot override them.
export const DEVIN_TEXT_TASK_CONFIG_ARG = '__ORCA_DEVIN_TEXT_TASK_CONFIG__'

// A recipe --config replaces the generated placeholder through the singleton group; then no
// policy file is attached and the user's own config governs the run.
export function devinTextTaskFiles(
  agentId: string,
  generationArgs: readonly GenerationArgument[]
): { name: string; content: string; argIndex: number }[] | undefined {
  if (agentId !== 'devin') {
    return undefined
  }
  const argIndex = generationArgs.findIndex(
    (arg) => generationArgumentText(arg) === DEVIN_TEXT_TASK_CONFIG_ARG
  )
  return argIndex === -1
    ? undefined
    : [{ name: 'devin-text-task-config.json', content: DEVIN_TEXT_TASK_CONFIG, argIndex }]
}

export const DEVIN_TEXT_TASK_CONFIG = JSON.stringify({
  // normal prompts on anything the deny list misses; a print run cannot answer, so it fails closed.
  permission_mode: 'normal',
  read_config_from: {
    agents_standard: false,
    cursor: false,
    windsurf: false,
    claude: false,
    copilot: false,
    codex: false,
    kiro: false,
    opencode: false,
    zed: false,
    cloud: false
  },
  permissions: {
    deny: [
      'read',
      'grep',
      'glob',
      'edit',
      'write',
      'exec',
      'webfetch',
      'notebook_edit',
      'run_subagent',
      'read_subagent',
      'ask_user_question',
      'mcp__*'
    ]
  }
})
