import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../catalog/tui-agent'
import { YOLO_TUI_AGENT_ARGS } from '../permissions/tui-agent-permissions'

const CLAUDE_BYPASS_ARGS = YOLO_TUI_AGENT_ARGS.claude ?? ''
const MANAGED_AUTH_DIR = /[\\/]claude-accounts[\\/][A-Za-z0-9_-]+[\\/]auth$/

/** A managed account's Claude config dir, read from a hook transcript path; other paths stay untouched. */
function managedClaudeAuthDir(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) {
    return undefined
  }
  const projectsIndex = transcriptPath.replace(/\\/g, '/').lastIndexOf('/projects/')
  if (projectsIndex <= 0) {
    return undefined
  }
  // Slash and backslash are both one character, so the index names the same cut in the original path.
  const configDir = transcriptPath.slice(0, projectsIndex)
  return MANAGED_AUTH_DIR.test(configDir.replace(/\\/g, '/')) ? configDir : undefined
}

function resumeAgentEnv(
  agent: TuiAgent,
  providerSession: AgentProviderSessionMetadata | null | undefined,
  recorded: Record<string, string>
): Record<string, string> {
  // A saved record cannot carry Orca's account env; restore it from the transcript when it names a managed account (#24752).
  const authDir =
    agent === 'claude' ? managedClaudeAuthDir(providerSession?.transcriptPath) : undefined
  return authDir && !recorded.CLAUDE_CONFIG_DIR
    ? { ...recorded, CLAUDE_CONFIG_DIR: authDir }
    : recorded
}

/** Replay the recorded recipe; without one, no settings Arguments/env, only a reported bypass (#29898). */
export function resolveResumeLaunchRecipe(
  launchConfig: SleepingAgentLaunchConfig | undefined,
  agent: TuiAgent,
  providerSession: AgentProviderSessionMetadata | null | undefined
): SleepingAgentLaunchConfig {
  if (!launchConfig) {
    // Why Claude only: its hooks are the ones that report a root agent's permission mode.
    const bypass = agent === 'claude' && providerSession?.permissionMode === 'bypassPermissions'
    return {
      agentArgs: bypass ? CLAUDE_BYPASS_ARGS : '',
      agentEnv: resumeAgentEnv(agent, providerSession, {})
    }
  }
  return {
    agentArgs: launchConfig.agentArgs,
    agentEnv: resumeAgentEnv(agent, providerSession, launchConfig.agentEnv),
    ...(launchConfig.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig.ompResumeFilePath ? { ompResumeFilePath: launchConfig.ompResumeFilePath } : {})
  }
}
