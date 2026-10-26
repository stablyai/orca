import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult
} from '../../../../../../shared/worktree/create-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorkspaceKey } from '../../../../../../shared/folder-workspace-types'
import type { TaskSourceContext } from '../../../../../../shared/task-source-context'
import type { WorkspaceLinkedItem } from '../../../../../../shared/worktree/types'

/** Trailing bag for `createWorktree` args that outgrew its positional list. */
export type CreateWorktreeCallOptions = {
  branchIntent?: CreateWorktreeArgs['branchIntent']
  /** Captured before background preparation so navigation cannot retarget creation. */
  executionHostId?: ExecutionHostId
  automationProvenanceRequest?: CreateWorktreeArgs['automationProvenanceRequest']
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
  /** Lets the owning runtime launch and prefill a task agent without first creating an idle shell. */
  startupDraft?: string
  /** A terminal agent the owning host may plan from its own settings; `startup` stays the fallback. */
  hostAgentLaunch?: HostAgentLaunch
  setupOnly?: boolean
  /** True only when `name` came from the creature-name generator; gates host-side retirement. */
  nameWasGenerated?: boolean
  displayNameKind?: CreateWorktreeArgs['displayNameKind']
  /** Parent picked in the composer. Sets sidebar nesting only; ignored if it no longer exists. */
  parentWorktreeId?: string
  provisionedRoot?: {
    runtimeId: string
    executionHostId: ExecutionHostId
    expectedPath: string
    expectedRefHead?: string
  }
}

export type HostAgentLaunch = {
  agent: TuiAgent
  prompt?: string
  launchSource?: string
}

/** `hostPlannedStartup`: the host was asked to build the agent launch, so no desktop plan may run. */
export type CreatedWorktreeResult = CreateWorktreeResult & { hostPlannedStartup?: true }

/** Pack create inputs once for both transports; retry-specific fields live in WorktreeCreateAttempt. */
export type WorktreeCreateRequest = Omit<CreateWorktreeArgs, 'parentWorkspace' | 'manualOrder'> & {
  options?: CreateWorktreeCallOptions
}

/** Per-attempt values: names carry the conflict-retry suffix, the parent can be dropped on retry. */
export type WorktreeCreateAttempt = {
  name: string
  branchNameOverride?: string
  parentWorkspace?: WorkspaceKey
  manualOrder?: number
}

/** Fields both transports spell the same way; one builder keeps IPC and RPC payloads from drifting. */
function sharedCreateFields(
  request: WorktreeCreateRequest,
  attempt: WorktreeCreateAttempt
): Omit<CreateWorktreeArgs, 'repoId' | 'startup' | 'creationId'> {
  const { options } = request
  return {
    name: attempt.name,
    ...(options?.nameWasGenerated ? { nameWasGenerated: true } : {}),
    baseBranch: request.baseBranch,
    ...(request.compareBaseRef ? { compareBaseRef: request.compareBaseRef } : {}),
    ...(attempt.branchNameOverride ? { branchNameOverride: attempt.branchNameOverride } : {}),
    ...(request.branchIntent ? { branchIntent: request.branchIntent } : {}),
    setupDecision: request.setupDecision,
    ...(options?.setupOnly !== undefined ? { setupOnly: options.setupOnly } : {}),
    sparseCheckout: request.sparseCheckout,
    ...(request.displayName ? { displayName: request.displayName } : {}),
    ...((request.displayNameKind ?? options?.displayNameKind)
      ? { displayNameKind: request.displayNameKind ?? options?.displayNameKind }
      : {}),
    ...(request.telemetrySource ? { telemetrySource: request.telemetrySource } : {}),
    ...(request.linkedIssue !== undefined ? { linkedIssue: request.linkedIssue } : {}),
    ...(request.linkedPR !== undefined ? { linkedPR: request.linkedPR } : {}),
    ...(request.pushTarget ? { pushTarget: request.pushTarget } : {}),
    ...(request.createdWithAgent ? { createdWithAgent: request.createdWithAgent } : {}),
    ...(request.pendingFirstAgentMessageRename === true && request.createdWithAgent
      ? { pendingFirstAgentMessageRename: true }
      : {}),
    ...(request.linkedLinearIssue !== undefined
      ? { linkedLinearIssue: request.linkedLinearIssue }
      : {}),
    ...(request.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: request.linkedLinearIssueWorkspaceId }
      : {}),
    ...(request.linkedLinearIssueOrganizationUrlKey !== undefined
      ? {
          linkedLinearIssueOrganizationUrlKey: request.linkedLinearIssueOrganizationUrlKey
        }
      : {}),
    ...(attempt.manualOrder !== undefined ? { manualOrder: attempt.manualOrder } : {}),
    ...(attempt.parentWorkspace ? { parentWorkspace: attempt.parentWorkspace } : {}),
    ...(request.workspaceStatus !== undefined ? { workspaceStatus: request.workspaceStatus } : {}),
    ...(request.linkedGitLabMR !== undefined ? { linkedGitLabMR: request.linkedGitLabMR } : {}),
    ...(request.linkedGitLabIssue !== undefined
      ? { linkedGitLabIssue: request.linkedGitLabIssue }
      : {}),
    ...(request.linkedBitbucketPR !== undefined
      ? { linkedBitbucketPR: request.linkedBitbucketPR }
      : {}),
    ...(request.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: request.linkedAzureDevOpsPR }
      : {}),
    ...(request.linkedGiteaPR !== undefined ? { linkedGiteaPR: request.linkedGiteaPR } : {}),
    ...(options?.linkedWorkItem !== undefined ? { linkedWorkItem: options.linkedWorkItem } : {}),
    ...(options?.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: options.linkedTaskSourceContext }
      : {}),
    ...(options?.automationProvenanceRequest
      ? { automationProvenanceRequest: options.automationProvenanceRequest }
      : {})
  }
}

export function buildLocalWorktreeCreateArgs(
  request: WorktreeCreateRequest,
  attempt: WorktreeCreateAttempt
): CreateWorktreeArgs {
  return {
    repoId: request.repoId,
    ...sharedCreateFields(request, attempt),
    ...(request.startup ? { startup: request.startup } : {}),
    ...(request.creationId ? { creationId: request.creationId } : {})
  }
}

export function buildRuntimeWorktreeCreateParams(
  request: WorktreeCreateRequest,
  attempt: WorktreeCreateAttempt,
  hostAgentLaunch?: HostAgentLaunch
): Record<string, unknown> {
  const { startup, options } = request
  return {
    repo: request.repoId,
    ...sharedCreateFields(request, attempt),
    // Why: the host defaults a bare `parentWorkspace` to CLI provenance; app picks are manual.
    ...(attempt.parentWorkspace ? { parentWorkspaceOrigin: 'manual' } : {}),
    // Switch point: a host lists the window's creation under its id only on the dark path.
    ...(ORCA_SIDEBAR_INPUTS_IS_MAIN && request.creationId
      ? { creationId: request.creationId }
      : {}),
    ...(options?.startupDraft ? { startupDraft: options.startupDraft } : {}),
    ...(hostAgentLaunch
      ? buildHostAgentLaunchParams(hostAgentLaunch)
      : startup
        ? {
            startupCommand: startup.command,
            ...(startup.env ? { startupEnv: startup.env } : {}),
            ...(startup.launchConfig ? { startupLaunchConfig: startup.launchConfig } : {}),
            ...(startup.startupCommandDelivery
              ? { startupCommandDelivery: startup.startupCommandDelivery }
              : {}),
            activate: true
          }
        : {})
  }
}

// Why: the host carries `startupPrompt` in the launch line or sends it after readiness, as the
// desktop plan did, and refuses an agent it has disabled.
function buildHostAgentLaunchParams(launch: HostAgentLaunch): Record<string, unknown> {
  return {
    startupAgent: launch.agent,
    ...(launch.prompt ? { startupPrompt: launch.prompt } : {}),
    ...(launch.launchSource ? { launchSource: launch.launchSource } : {}),
    activate: true
  }
}
