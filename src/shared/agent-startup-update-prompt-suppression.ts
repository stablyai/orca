import type { TuiAgent } from './tui-agent'

// Why: Codex's startup "Update now" installs and exits, consuming a launch whose prepared prompt
// has not been delivered yet. Absent agents have no interactive startup updater to skip.
const SUPPRESSION_ARGS: Partial<Record<TuiAgent, readonly string[]>> = {
  codex: ['-c', 'check_for_update_on_startup=false']
}

/**
 * Launch-only args that skip the agent's interactive startup update prompt, for a launch that
 * carries generated context. Shaped for spreading into startup-plan inputs: they ride the typed
 * command but never the persisted resume configuration.
 */
export function startupUpdatePromptSuppressionInputs(
  agent: TuiAgent,
  suppress: boolean | undefined
): { transientAgentArgs?: readonly string[] } {
  const args = suppress ? SUPPRESSION_ARGS[agent] : undefined
  return args ? { transientAgentArgs: args } : {}
}
