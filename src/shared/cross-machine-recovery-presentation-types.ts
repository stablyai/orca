import type { RecoveryLayout, RecoveryPresentationFocus } from './cross-machine-recovery-descriptor'

export const MAX_RECOVERY_PRESENTATION_PUBLISH_BYTES = 512 * 1024
export const MAX_RECOVERY_PRESENTATION_WORKSPACES = 64
export const MAX_RECOVERY_PRESENTATION_WORKSPACE_VIEW_BYTES = 64 * 1024
export const MAX_RECOVERY_PRESENTATION_CLIENTS = 16
export const RECOVERY_PRESENTATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const LOCAL_RENDERER_PRESENTATION_CLIENT_KEY = 'local-renderer'

export function pairedDevicePresentationClientKey(pairedDeviceId: string): string {
  return `device:${pairedDeviceId}`
}

export type RecoveryPresentationWorkspaceRef =
  | { kind: 'worktree'; worktreeId: string; instanceId?: string }
  | { kind: 'folder'; folderWorkspaceId: string }

/** Ages relative to the publish, so the host can stamp absolute times on its own clock. */
export type RecoveryPresentationInput = {
  msSinceHumanInput: number | null
  msSinceHumanFocus: number | null
  msSinceHumanInputByPaneKey: Record<string, number>
}

export type RecoveryPresentationWorkspace = {
  workspace: RecoveryPresentationWorkspaceRef
  view: RecoveryLayout
  focus: RecoveryPresentationFocus
  input: RecoveryPresentationInput
}

/** A full replace of one client's views for this host. */
export type RecoveryPresentationPublishParams = {
  clientInstanceId: string
  clientName: string
  clientRevision: number
  workspaces: RecoveryPresentationWorkspace[]
}

export type RecoveryPresentationPublishResult =
  | { ok: true; acknowledgedRevision: number; hostReceivedAt: number }
  | {
      ok: false
      reason: 'stale-revision' | 'too-large' | 'unavailable'
      acknowledgedRevision?: number
    }
