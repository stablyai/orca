import type { WorkspaceCanvasDocument } from './maestro-document-contract'
import type { WorkspaceSurfaceId, WorkspaceSurfaceSnapshot } from './maestro-workspace-canvas'
import type { TuiAgent } from './tui-agent'

export type RuntimeMaestroWorkspaceCanvasScope = {
  execution_host_id: string
  workspace_key: string
}

export type RuntimeMaestroWorkspaceCanvasQueryResult =
  | {
      status: 'available'
      actor_id: string
      snapshot: WorkspaceSurfaceSnapshot
      canvas: { revision: number; document: WorkspaceCanvasDocument; updated_at: string | null }
    }
  | {
      status: 'unavailable'
      reason: 'update-required' | 'authority-unreachable' | 'scope-unavailable'
      liveness: 'unverifiable'
      last_known_snapshot?: WorkspaceSurfaceSnapshot
    }

type RuntimeMaestroWorkspaceCanvasMutationBase = {
  scope: RuntimeMaestroWorkspaceCanvasScope
  actor_id: string
  expected_authority_revision: number
  idempotency_key: string
}

type RuntimeMaestroWorkspaceCanvasDocumentMutationBase =
  RuntimeMaestroWorkspaceCanvasMutationBase & { expected_canvas_revision: number }

export type RuntimeMaestroWorkspaceCanvasMutation =
  | (RuntimeMaestroWorkspaceCanvasMutationBase & {
      action: 'create'
      surface_type: 'terminal'
      title?: string
      agent?: TuiAgent
      expected_canvas_revision?: number
      placement?: WorkspaceCanvasDocument['placements'][string]
    })
  | (RuntimeMaestroWorkspaceCanvasMutationBase & {
      action: 'create'
      surface_type: 'browser'
      title?: string
      expected_canvas_revision?: number
      placement?: WorkspaceCanvasDocument['placements'][string]
    })
  | (RuntimeMaestroWorkspaceCanvasDocumentMutationBase & {
      action: 'create'
      surface_type: 'content'
      title?: string
      annotation: {
        text: string
        tone: 'decision' | 'warning' | 'blocked' | 'observation'
      }
      placement?: WorkspaceCanvasDocument['placements'][string]
    })
  | (RuntimeMaestroWorkspaceCanvasDocumentMutationBase & {
      action: 'focus' | 'close'
      surface_id: WorkspaceSurfaceId
    })
  | (RuntimeMaestroWorkspaceCanvasMutationBase & {
      action: 'rename'
      surface_id: WorkspaceSurfaceId
      title: string
    })
  | (RuntimeMaestroWorkspaceCanvasDocumentMutationBase & {
      action: 'update-annotation'
      surface_id: WorkspaceSurfaceId
      content?: string
      tone: 'decision' | 'warning' | 'blocked' | 'observation'
    })
  | (RuntimeMaestroWorkspaceCanvasDocumentMutationBase & {
      action: 'set-placement'
      surface_id: WorkspaceSurfaceId
      placement: WorkspaceCanvasDocument['placements'][string]
    })
  | (RuntimeMaestroWorkspaceCanvasDocumentMutationBase & {
      action: 'set-viewport'
      viewport: NonNullable<WorkspaceCanvasDocument['viewport']>
    })
  | (RuntimeMaestroWorkspaceCanvasDocumentMutationBase & {
      action: 'create-manual-link'
      source_surface_key: string
      target_surface_key: string
      link_type: string
      label: string | null
    })
  | (RuntimeMaestroWorkspaceCanvasDocumentMutationBase & {
      action: 'delete-manual-link'
      link_id: string
    })
  | (RuntimeMaestroWorkspaceCanvasDocumentMutationBase & {
      action: 'decide-suggestion'
      fingerprint: string
      decision: 'accepted' | 'hidden'
      link_type?: string
      label?: string | null
    })

export type RuntimeMaestroWorkspaceCanvasMutationResult = {
  status: 'applied' | 'replayed' | 'cancelled' | 'stale' | 'outcome_unknown' | 'unavailable'
  authority_revision: number
  canvas_revision?: number
  surface_id?: WorkspaceSurfaceId
  reason?: string
  liveness?: 'unverifiable'
}

export type RuntimeMaestroWorkspaceTabCommand =
  | {
      requestId: string
      kind: 'open-annotation'
      worktreeId: string
      filePath: string
      relativePath: string
      title?: string
    }
  | {
      requestId: string
      kind: 'rename'
      worktreeId: string
      tabId: string
      title: string
    }
  | {
      requestId: string
      kind: 'read-content'
      worktreeId: string
      tabId: string
    }
  | {
      requestId: string
      kind: 'focus'
      worktreeId: string
      tabId: string
    }

export type RuntimeMaestroWorkspaceTabCommandResponse = {
  requestId: string
  ok: boolean
  tabId?: string
  content?: string
  modelRevision?: string
  error?: string
}

export type RuntimeMaestroWorkspaceContentReadResult = {
  tabId: string
  content: string
  modelRevision: string
}
