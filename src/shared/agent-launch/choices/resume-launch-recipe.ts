import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../catalog/tui-agent'
import { YOLO_TUI_AGENT_ARGS } from '../permissions/tui-agent-permissions'

const CLAUDE_BYPASS_ARGS = YOLO_TUI_AGENT_ARGS.claude ?? ''

/** Replay the recorded recipe. Without one, Orca adds no settings Arguments, env or permission
 *  default (the configured Command still runs); only a session that reported bypass keeps it,
 *  so a hand-typed agent never gains a bypass it lacked (#29898). */
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
    ...(launchConfig.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig.ompResumeFilePath ? { ompResumeFilePath: launchConfig.ompResumeFilePath } : {})
  }
}
