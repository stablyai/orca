import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../catalog/tui-agent'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from '../permissions/tui-agent-permissions'

/** Replay the recorded recipe; without one, no settings Arguments/env, only an observed bypass (#29898). */
export function resolveResumeLaunchRecipe(
  launchConfig: SleepingAgentLaunchConfig | undefined,
  agent: TuiAgent,
  providerSession: AgentProviderSessionMetadata | null | undefined
): SleepingAgentLaunchConfig {
  if (!launchConfig) {
    return providerSession?.permissionMode === 'bypassPermissions'
      ? {
          agentArgs: YOLO_TUI_AGENT_ARGS[agent] ?? '',
          agentEnv: { ...YOLO_TUI_AGENT_ENV[agent] }
        }
      : { agentArgs: '', agentEnv: {} }
  }
  return {
    agentArgs: launchConfig.agentArgs,
    agentEnv: launchConfig.agentEnv,
    ...(launchConfig.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig.ompResumeFilePath ? { ompResumeFilePath: launchConfig.ompResumeFilePath } : {})
  }
}
