import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../../shared/workspace-source'
import type { LaunchSource } from '../../../../../shared/telemetry-property-schemas'

export type StartFixChecksAgentArgs = {
  repoId: string
  basePrompt: string
  item?: GitHubWorkItem
  worktreeId?: string | null
  groupId?: string | null
  launchSource: LaunchSource
  telemetrySource?: WorkspaceCreateTelemetrySource
  openModalFallback?: () => void
  onSetupRequired?: () => void
}
