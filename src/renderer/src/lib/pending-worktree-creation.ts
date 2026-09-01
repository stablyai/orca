import type {
  CreateSparseCheckoutRequest,
  GitPushTarget,
  SetupDecision,
  TuiAgent,
  WorkspaceCreateTelemetrySource,
  WorkspaceStatus,
  WorkspaceLinkedItem
} from '../../../shared/types'
import type { AgentLaunchSpawnRequest } from '../../../shared/agent-launch-spawn-request'
import type { AgentStartedTelemetry } from '@/lib/worktree-activation'
import type { TaskSourceContext, WorkspaceRunContext } from '../../../shared/task-source-context'
import type { AgentStartupPlan } from '../../../shared/tui-agent-startup'
import type { EphemeralVmCheckoutMode } from '../../../shared/orca-yaml-hook-types'

/** Two-phase status reported by the main process while a worktree is created.
 *  `preparing` covers renderer-side preflight before `createWorktree` starts;
 *  `fetching` covers the base-ref git fetch; `creating` covers `git worktree
 *  add`. Remote/runtime creates may skip git phases; VM recipes add a
 *  provider-provisioning phase before the runtime worktree exists. */
export type WorktreeCreationPhase = 'preparing' | 'provisioning-vm' | 'fetching' | 'creating'

export type WorktreeCreationProgressMode = 'stepped' | 'indeterminate'

/**
 * Everything needed to run a worktree create in the background and reproduce it
 * verbatim on retry. Captured at the composer's submit cut point — after all
 * interactive preflight (trust/setup decisions) has resolved — so the modal can
 * close immediately and the work outlives it. Must stay plain-serializable
 * (no closures/refs) so a pending entry can hold it for the panel's Retry.
 */
export type WorktreeCreationRequest = {
  repoId: string
  /** Source host/account that produced the linked task. Kept separate from the
   *  run context so Retry does not infer provider ownership from the run host. */
  taskSourceContext?: TaskSourceContext | null
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
  /** Host/setup where the new workspace should run. Duplicates repoId by design:
   *  repoId keeps old create APIs working, while this records the project-first
   *  host intent for retry, diagnostics, and future metadata writes. */
  workspaceRunContext?: WorkspaceRunContext | null
  /** Ephemeral VM runtime provisioned for this create. Used for best-effort
   *  cleanup if Orca fails before the workspace owns the runtime. */
  ephemeralVmRuntimeId?: string
  /** Runtime environment created from the VM's pairing code. Used to refresh
   *  live status immediately after the workspace takes ownership. */
  ephemeralVmRuntimeEnvironmentId?: string
  /** Recipe to provision before creating the worktree. Kept serializable so
   *  retry can rerun the recipe after a failed create. */
  ephemeralVmRecipe?: {
    sourceRepoId: string
    recipeId: string
    projectId: string
    checkoutMode?: EphemeralVmCheckoutMode
  }
  ephemeralVmCheckoutMode?: EphemeralVmCheckoutMode
  ephemeralVmExpectedRefHead?: string
  /** Captured from the repo/run owner at submit time so Retry keeps the same
   *  local-vs-runtime progress behavior even if the focused runtime changes. */
  worktreeCreateProgressMode?: WorktreeCreationProgressMode
  name: string
  /** True only when `name` came from Orca's creature-name generator. Must survive
   *  into the create call: the host retires generated names so one is never
   *  reissued, and a name the user typed stays reusable. */
  nameWasGenerated?: boolean
  displayName?: string
  displayNameKind?: 'generated' | 'user'
  baseBranch?: string
  compareBaseRef?: string
  setupDecision: SetupDecision
  sparseCheckout?: CreateSparseCheckoutRequest
  telemetrySource?: WorkspaceCreateTelemetrySource
  linkedIssue?: number
  linkedPR?: number
  pushTarget?: GitPushTarget
  agent: TuiAgent | null
  linkedLinearIssue?: string
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  branchNameOverride?: string
  /** Parent picked in the composer's Advanced drawer. Sidebar nesting only, no git effect. */
  parentWorktreeId?: string
  workspaceStatus?: WorkspaceStatus
  linkedGitLabMR?: number
  linkedGitLabIssue?: number
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  /** Host-resolved two-stage agent launch. When present the host owns resolution
   *  and spawns the primary agent terminal on create; the renderer consumes the
   *  `launched` receipt (never argv/env) and materializes setup/default tabs
   *  around it. Absent for blank-shell creates. */
  agentLaunch?: AgentLaunchSpawnRequest
  /** Repo Custom GitHub Issue Command to run in a side-pane split after the
   *  workspace's first terminal is created. Mirrors the composer's trust-gated issueCommand. */
  issueCommand?: { command: string; env?: Record<string, string> }
  pendingFirstAgentMessageRename: boolean
  /** Post-create note persisted as the worktree comment. */
  note: string
  /** Legacy renderer-owned startup retained for queued pre-host-launch requests. */
  startupPlan?: AgentStartupPlan | null
  quickPrompt?: string
  launchDraftPrompt?: string | null
  /** Telemetry emitted renderer-side off the host's `launched` receipt (the host
   *  create-spawn threads no telemetry). Null for blank-shell creates. */
  quickTelemetry: AgentStartedTelemetry | null
  /** When the composer stays open for sequential creates, completion must not
   *  steal focus from the next workspace name field. */
  suppressTerminalFocusOnCompletion?: boolean
}

/** Renderer-only, session-ephemeral record of an in-flight (or failed) worktree
 *  creation. Drives the sidebar strip and the in-tab creation panel. Never
 *  persisted — an app reload drops it and the worktree (if main finished it)
 *  reconciles in via the normal `worktrees:changed` refresh. Display fields
 *  (name, repo, agent) live on `request`, the single source of truth reused on
 *  retry. */
export type PendingWorktreeCreation = {
  creationId: string
  phase: WorktreeCreationPhase
  status: 'creating' | 'error'
  startedAt: number
  /** True when the create runs over a remote/runtime target that emits no phase
   *  progress — the panel shows a single indeterminate spinner rather than a
   *  stepped checklist that would freeze on the first step. */
  indeterminate: boolean
  /** Whether older callers have explicitly revealed the in-frame loader. New
   *  background creates set this immediately so the faux tab strip stays stable
   *  from create start through terminal handoff. */
  loaderVisible: boolean
  error?: string
  provisioningLog?: string
  request: WorktreeCreationRequest
}

export function findPendingLinkedWorkItemCreationId(
  pendingCreations: Readonly<Record<string, PendingWorktreeCreation>>,
  request: Pick<
    WorktreeCreationRequest,
    'repoId' | 'linkedIssue' | 'linkedPR' | 'workspaceRunContext'
  >
): string | null {
  if (request.linkedIssue == null && request.linkedPR == null) {
    return null
  }
  const hostId = request.workspaceRunContext?.hostId ?? null
  const match = Object.values(pendingCreations).find((entry) => {
    const pending = entry.request
    return (
      pending.repoId === request.repoId &&
      pending.linkedIssue === request.linkedIssue &&
      pending.linkedPR === request.linkedPR &&
      (pending.workspaceRunContext?.hostId ?? null) === hostId
    )
  })
  return match?.creationId ?? null
}

/** Human-readable progress line for an in-flight create, shared by the in-frame
 *  loader and the sidebar row so the two never drift. Caller handles the error
 *  case; this only covers the in-progress states. */
export function getCreationProgressLabel(
  entry: Pick<PendingWorktreeCreation, 'phase' | 'indeterminate'>
): string {
  if (entry.phase === 'provisioning-vm') {
    return 'Provisioning VM…'
  }
  if (entry.indeterminate) {
    return 'Setting up your workspace…'
  }
  if (entry.phase === 'preparing') {
    return 'Preparing workspace…'
  }
  return entry.phase === 'creating' ? 'Creating worktree…' : 'Fetching base branch…'
}
