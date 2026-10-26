import type { LinkedWorkItemContext } from '@/lib/linked-work-item-context'
import type { TaskProvider } from '../../../shared/task-providers'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
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
  agentArgs?: string | null
  /** The saved choice for `agentOverride`; a chat seeds it and a terminal applies it as flags. */
  sessionOptions?: Readonly<Record<string, string>>
  /** On terminals, a flag `agentArgs` sets itself wins over the inherited saved choice. */
  sessionOptionsYieldToAgentArgs?: true
  resolveAgentArgs?: (agent: TuiAgent) => string | null | undefined
  resolveSessionOptions?: (agent: TuiAgent) => Readonly<Record<string, string>> | undefined
  promptDelivery?: 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
}
