import type {
  CreateSparseCheckoutRequest,
  GitPushTarget,
  SetupDecision,
  TuiAgent,
  WorkspaceCreateTelemetrySource,
  WorkspaceStatus,
  WorktreeStartupLaunch
} from '../../../shared/types'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { AgentStartedTelemetry } from '@/lib/worktree-activation'

/** Two-phase status reported by the main process while a worktree is created.
 *  `fetching` covers the base-ref git fetch; `creating` covers `git worktree
 *  add`. The remote/runtime path emits neither, so consumers must tolerate a
 *  phase that never advances past `fetching`. */
export type WorktreeCreationPhase = 'fetching' | 'creating'

/**
 * Everything needed to run a worktree create in the background and reproduce it
 * verbatim on retry. Captured at the composer's submit cut point — after all
 * interactive preflight (trust/setup decisions) has resolved — so the modal can
 * close immediately and the work outlives it. Must stay plain-serializable
 * (no closures/refs) so a pending entry can hold it for the panel's Retry.
 */
export type WorktreeCreationRequest = {
  repoId: string
  name: string
  displayName?: string
  baseBranch?: string
  setupDecision: SetupDecision
  sparseCheckout?: CreateSparseCheckoutRequest
  telemetrySource?: WorkspaceCreateTelemetrySource
  linkedIssue?: number
  linkedPR?: number
  pushTarget?: GitPushTarget
  agent: TuiAgent | null
  linkedLinearIssue?: string
  branchNameOverride?: string
  workspaceStatus?: WorkspaceStatus
  linkedGitLabMR?: number
  linkedGitLabIssue?: number
  /** Backend-spawn startup payload (`createWorktree` arg). Present only when the
   *  agent launch is self-contained; otherwise the renderer drives startup via
   *  `startupPlan`. */
  startup?: WorktreeStartupLaunch
  pendingFirstAgentMessageRename: boolean
  /** Post-create note persisted as the worktree comment. */
  note: string
  /** Renderer-side launch plan used to seed the first terminal when the backend
   *  did not already spawn it. Null for blank-shell creates. */
  startupPlan: AgentStartupPlan | null
  quickPrompt: string
  quickTelemetry: AgentStartedTelemetry | null
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
  /** True when the create runs over a remote/runtime target that emits no phase
   *  progress — the panel shows a single indeterminate spinner rather than a
   *  stepped checklist that would freeze on the first step. */
  indeterminate: boolean
  error?: string
  request: WorktreeCreationRequest
}
