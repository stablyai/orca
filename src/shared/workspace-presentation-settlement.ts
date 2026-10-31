import type { WorkspacePresentation, WorkspaceSourceBaseline } from './workspace-presentation'
import { reconcileWorkspacePresentation } from './workspace-presentation-reconcile'
import { recordWorkspacePresentationIntent } from './workspace-presentation-user-intent'

/** Admission records only accepted old-source semantic edits, never derived membership placement. */
export function settleWorkspacePresentation(
  saved: WorkspacePresentation,
  sources: readonly WorkspaceSourceBaseline[]
): WorkspacePresentation {
  const edits = new Set<string>()
  const next = reconcileWorkspacePresentation(saved, sources, (key) => edits.add(key))
  recordWorkspacePresentationIntent(saved, edits, next)
  return next
}
