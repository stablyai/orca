// Pieces of the "Move to this computer" run (orca-cloud-transfer-flow.ts).
import { useAppStore } from '@/store'
import type { CreatedWorktreeResult } from '@/store/slices/worktrees/create/worktree-create-payload'
import { getCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { setCloudWorkspacePending } from '@/lib/orca-cloud/orca-cloud-workspace-actions'
import { translate } from '@/i18n/i18n'
import { showWorktreeCreationReadyToast } from '@/lib/workspace/creation/worktree-creation-ready-toast'
import type { CloudMoveStep } from '@/lib/orca-cloud/orca-cloud-move-store'
import type { CloudTransferProgressEvent } from '../../../../shared/hosted-sandbox/cloud-transfer-api'

export const STEP_OF_PHASE: Partial<Record<CloudTransferProgressEvent['phase'], CloudMoveStep>> = {
  packing: 'packing',
  downloading: 'downloading',
  importing: 'downloading',
  'creating-worktree': 'creating',
  applying: 'applying'
}

/** Failures a retry repeats exactly: the card offers no Retry for them. */
export const NOT_RETRYABLE: ReadonlySet<string> = new Set([
  'too_large',
  'no_local_repo',
  'no_commits'
])

/** Thrown inside the run once Cancel has been honoured. */
export class MoveCancelled extends Error {}

/** A failure with a reason the card names (main's code: too_large, no_local_repo, busy…). */
export class MoveFailed extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** Ends the cloud workspace's "moving" hold, unless something else (archive) took it since. */
export function releaseMoveHold(workspaceId: string): void {
  if (getCloudWorkspaceSnapshot().pending[workspaceId] === 'move') {
    setCloudWorkspacePending(workspaceId, null)
  }
}

/** The local workspace, through the ordinary create path, on the branch the move brought over. */
export async function createMovedWorktree(
  repoId: string,
  branch: string,
  baseBranch: string | null
): Promise<CreatedWorktreeResult['worktree']> {
  const { worktree } = await useAppStore
    .getState()
    .createWorktree(
      repoId,
      branch,
      baseBranch ?? undefined,
      'inherit',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      branch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { branchIntent: 'open-existing-v2' }
    )
  return worktree
}

/**
 * A move that landed in full: the same toast as a workspace created in the background ("Go to
 * workspace" becomes "Open here", the local copy). A partial result keeps the card instead.
 */
export function showCloudMoveDoneToast(
  worktree: Parameters<typeof showWorktreeCreationReadyToast>[0],
  name: string,
  archived: boolean,
  archiveTtlDays: number
): void {
  showWorktreeCreationReadyToast(worktree, undefined, {
    title: translate('orcaCloudMove.title.movedHere', 'Moved {{name}} here', { name }),
    ...(archived
      ? {
          description: translate(
            'orcaCloudMove.done.archivedShort',
            'Cloud copy archived; deleted in {{count}} days.',
            {
              count: archiveTtlDays,
              defaultValue_one: 'Cloud copy archived; deleted in {{count}} day.'
            }
          )
        }
      : {}),
    actionLabel: translate('orcaCloudMove.openHere', 'Open here')
  })
}
