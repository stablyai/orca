import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../../shared/workspace/creation/workspace-source'
import type { LaunchSource } from '../../../../../shared/telemetry/schemas/telemetry-property-schemas'

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
