import type { WorkspaceKey } from '../folder-workspaces/folder-workspace-types'

export type WorktreeLineageOrigin = 'orchestration' | 'cli' | 'manual'
export type WorktreeLineageCaptureConfidence = 'explicit' | 'inferred'
export type WorktreeLineageCaptureSource =
  | 'explicit-cli-flag'
  | 'env-workspace'
  | 'cwd-context'
  | 'terminal-context'
  | 'orchestration-context'
  | 'active-workspace'
  | 'manual-action'

export type WorktreeLineageCapture = {
  source: WorktreeLineageCaptureSource
  confidence: WorktreeLineageCaptureConfidence
}

export type WorktreeLineage = {
  worktreeId: string
  worktreeInstanceId: string
  parentWorktreeId: string
  parentWorktreeInstanceId: string
  origin: WorktreeLineageOrigin
  capture: WorktreeLineageCapture
  orchestrationRunId?: string
  taskId?: string
  coordinatorHandle?: string
  createdByTerminalHandle?: string
  createdAt: number
}

export type WorkspaceLineage = {
  childWorkspaceKey: WorkspaceKey
  childInstanceId?: string | null
  parentWorkspaceKey: WorkspaceKey
  parentInstanceId?: string | null
  origin: WorktreeLineageOrigin
  capture: WorktreeLineageCapture
  taskId?: string
  orchestrationRunId?: string
  coordinatorHandle?: string
  createdByTerminalHandle?: string
  createdAt: number
}

/** A parent saved in another Orca store; `instanceId` is identity, `workspaceKey` only a hint. */
export type CrossStoreParentRef = {
  /** The parent store's installationId (host-installation.json). */
  installationId: string
  workspaceKey: WorkspaceKey
  instanceId: string
}

/** Owned by the child's store; maintenance acts on it only through the child. */
export type CrossStoreWorkspaceLineage = {
  childWorkspaceKey: WorkspaceKey
  childInstanceId: string
  parent: CrossStoreParentRef
  origin: WorktreeLineageOrigin
  capture: WorktreeLineageCapture
  taskId?: string
  orchestrationRunId?: string
  coordinatorHandle?: string
  createdByTerminalHandle?: string
  createdAt: number
}

export type WorktreeLineageWarningCode =
  | 'LINEAGE_PARENT_CONTEXT_MISSING'
  | 'LINEAGE_PARENT_CONTEXT_CONFLICT'
  | 'LINEAGE_PARENT_INSTANCE_STALE'

export type WorktreeLineageWarning = {
  code: WorktreeLineageWarningCode
  message: string
  details?: Record<string, unknown>
}
