import type { LinkedWorkItemContext } from '@/lib/linked-work-item-context'
import type {
  GitLabProjectRef,
  PersistedIssueSourcePreference,
  TuiAgent,
  WorkspaceCreateTelemetrySource
} from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'

export type LaunchableWorkItem = {
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
  jiraIdentifier?: string
  jiraSiteId?: string
  gitLabProjectRef?: GitLabProjectRef | null
  issueSourcePreference?: PersistedIssueSourcePreference | null
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
  promptDelivery?: 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
}
