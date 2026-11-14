import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../agent-session/lifecycle/agent-session-resume'
import { readClaudeModel } from '../../agent-session/lifecycle/provider-session-live-settings'
import type { TuiAgent } from '../catalog/tui-agent'
import { YOLO_TUI_AGENT_ARGS } from '../permissions/tui-agent-permissions'

const CLAUDE_BYPASS_ARGS = YOLO_TUI_AGENT_ARGS.claude ?? ''

/** Replay the recorded recipe; without one, no settings Arguments/env, only a session's reported bypass (#29898) and model. */
export function resolveResumeLaunchRecipe(
  launchConfig: SleepingAgentLaunchConfig | undefined,
  agent: TuiAgent,
  providerSession: AgentProviderSessionMetadata | null | undefined
): SleepingAgentLaunchConfig {
  if (!launchConfig) {
    // Why Claude only: its hooks report a root agent's permission mode, and its launch line names the model of a session no hook named.
    const bypass = agent === 'claude' && providerSession?.permissionMode === 'bypassPermissions'
    const model = agent === 'claude' ? readClaudeModel(providerSession?.model) : undefined
    const args = [bypass ? CLAUDE_BYPASS_ARGS : '', model ? `--model ${model}` : '']
    return { agentArgs: args.filter(Boolean).join(' '), agentEnv: {} }
  }
  return {
    agentArgs: launchConfig.agentArgs,
    agentEnv: launchConfig.agentEnv,
    ...(launchConfig.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig.ompResumeFilePath ? { ompResumeFilePath: launchConfig.ompResumeFilePath } : {})
  }
}
