import type { LinkedWorkItemContext } from '@/lib/linked-work-item-context'
import type { TaskProvider, TuiAgent, WorkspaceCreateTelemetrySource } from '../../../shared/types'
import type { SourceControlLaunchActionId } from '../../../shared/source-control-ai-actions'
import type { LaunchSource } from '../../../shared/telemetry-events'

export type LaunchableWorkItem = {
  provider?: TaskProvider
  title: string
  url: string
  type: 'issue' | 'pr' | 'mr'
  number: number | null
  repoId?: string
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  pasteContent?: string
  linearIdentifier?: string
  linearWorkspaceId?: string
  linearOrganizationUrlKey?: string
  linkedContext?: LinkedWorkItemContext
}

export type LaunchWorkItemDirectArgs = {
  item: LaunchableWorkItem
  repoId: string
  openModalFallback: () => void
  baseBranch?: string
  launchSource: LaunchSource
  telemetrySource?: WorkspaceCreateTelemetrySource
  agentOverride?: TuiAgent
  /** Source-control recipe owner locator. When set, the host resolves this
   *  action's stored agentArgs and applies them to the launch (clients never
   *  send assembled args). Only `fixChecks` reaches here today, from the
   *  fix-checks launch surfaces. */
  sourceControlActionId?: SourceControlLaunchActionId
  promptDelivery?: 'draft' | 'submit-after-ready'
}
