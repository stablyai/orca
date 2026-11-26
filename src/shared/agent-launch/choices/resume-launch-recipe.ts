import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../catalog/tui-agent'
import { YOLO_TUI_AGENT_ARGS } from '../permissions/tui-agent-permissions'

const CLAUDE_BYPASS_ARGS = YOLO_TUI_AGENT_ARGS.claude ?? ''

/** Replay the recorded recipe; without one, no settings Arguments/env, only a reported bypass (#29898). */
export function resolveResumeLaunchRecipe(
  launchConfig: SleepingAgentLaunchConfig | undefined,
  agent: TuiAgent,
  providerSession: AgentProviderSessionMetadata | null | undefined
): SleepingAgentLaunchConfig {
  if (!launchConfig) {
    // Why Claude only: its hooks are the ones that report a root agent's permission mode.
    const bypass = agent === 'claude' && providerSession?.permissionMode === 'bypassPermissions'
    return { agentArgs: bypass ? CLAUDE_BYPASS_ARGS : '', agentEnv: {} }
  }
  return {
    agentArgs: launchConfig.agentArgs,
    agentEnv: launchConfig.agentEnv,
    ...(launchConfig.authoredCommand ? { authoredCommand: launchConfig.authoredCommand } : {}),
    ...(launchConfig.commandProvenance
      ? { commandProvenance: launchConfig.commandProvenance }
      : {}),
    ...(launchConfig.selectedExecutable
      ? { selectedExecutable: launchConfig.selectedExecutable }
      : {}),
    ...(launchConfig.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig.ompResumeFilePath ? { ompResumeFilePath: launchConfig.ompResumeFilePath } : {})
  }
}
