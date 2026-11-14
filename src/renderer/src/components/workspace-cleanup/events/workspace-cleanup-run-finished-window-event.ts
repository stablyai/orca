/** Fans a host's finished cleanup run out within the renderer, whichever transport delivered it. */
import type { WorkspaceCleanupRunFinishedEvent } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'

export const WORKSPACE_CLEANUP_RUN_FINISHED_EVENT = 'orca:workspace-cleanup-run-finished'

/** `environmentId` names the server whose runner finished; null is this app's own runner. */
export type WorkspaceCleanupRunFinishedWindowDetail = {
  environmentId: string | null
  run: WorkspaceCleanupRunFinishedEvent['run']
}

export function emitWorkspaceCleanupRunFinishedWindowEvent(
  detail: WorkspaceCleanupRunFinishedWindowDetail
): void {
  window.dispatchEvent(
    new CustomEvent<WorkspaceCleanupRunFinishedWindowDetail>(WORKSPACE_CLEANUP_RUN_FINISHED_EVENT, {
      detail
    })
  )
}

export function onWorkspaceCleanupRunFinished(
  listener: (detail: WorkspaceCleanupRunFinishedWindowDetail) => void
): () => void {
  const handle = (event: Event): void => {
    if (event instanceof CustomEvent && isRunFinishedDetail(event.detail)) {
      listener(event.detail)
    }
  }
  window.addEventListener(WORKSPACE_CLEANUP_RUN_FINISHED_EVENT, handle)
  return () => window.removeEventListener(WORKSPACE_CLEANUP_RUN_FINISHED_EVENT, handle)
}

function isRunFinishedDetail(value: unknown): value is WorkspaceCleanupRunFinishedWindowDetail {
  return typeof value === 'object' && value !== null && 'run' in value && 'environmentId' in value
}
