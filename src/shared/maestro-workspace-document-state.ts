import type { WorkspaceSuggestedLink } from './maestro-workspace-canvas'
import type { WorkspaceCanvasDocument } from './maestro-document-contract'

export type WorkspaceSuggestionState = 'pending' | 'accepted' | 'hidden'

export function emptyWorkspaceCanvasDocument(): WorkspaceCanvasDocument {
  return {
    schema_version: 1,
    last_surface_revision: 0,
    placements: {},
    manual_links: [],
    suggestion_decisions: {},
    annotations: {},
    ui_preferences: { inspector_open: false, inspector_width: 320 }
  }
}

export function workspaceSuggestionState(
  suggestion: Pick<WorkspaceSuggestedLink, 'fingerprint' | 'revision'>,
  document: WorkspaceCanvasDocument
): WorkspaceSuggestionState {
  const decision = document.suggestion_decisions[suggestion.fingerprint]
  if (!decision || decision.suggestion_revision !== suggestion.revision) {
    return 'pending'
  }
  return decision.state
}
