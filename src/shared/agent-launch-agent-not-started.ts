export const AGENT_LAUNCH_AGENT_NOT_STARTED_CODE = 'agent_launch_agent_not_started' as const

// A launch that created its workspace and provably never started its agent there: the workspace is
// kept, and the answer names it so the caller can open it. Only a client advertising
// `agent.launch.workspace-kept.v1` is told so; any other reads the uncertain answer it always got.
export class AgentLaunchWorkspaceKeptError extends Error {
  constructor(
    readonly worktreeId: string,
    options?: { cause?: unknown }
  ) {
    super(AGENT_LAUNCH_AGENT_NOT_STARTED_CODE, options)
    this.name = 'AgentLaunchWorkspaceKeptError'
  }
}
