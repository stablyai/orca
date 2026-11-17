import type { AgentLaunchInputViews } from '../../../../shared/agent-launch/choices/agent-launch-choices'
import type { AgentPickerSurface } from '../../../../shared/agent-launch/picker/agent-launch-picker'

/** How the composer's agent starts: its picked surface (chat or terminal) and setup, when chosen. */
export type CloudFirstAgentLaunch = AgentLaunchInputViews & {
  requestedSurface?: AgentPickerSurface
}

/** What a GitHub-only Orca Cloud create starts from. */
export type GitHubCreateSource = {
  repoUrl: string
  /** `owner/repo`. */
  fullName: string
  /**
   * The composer's name field: the workspace's title, never the agent's prompt.
   */
  name: string
  /** The project the composer had selected, for Back to draft. */
  composerRepoId: string
  /** The first agent's launch; absent follows the person's default surface. */
  firstAgent?: CloudFirstAgentLaunch
}
