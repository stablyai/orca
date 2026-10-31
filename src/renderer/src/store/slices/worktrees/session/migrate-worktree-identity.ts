import { retireLocalSourceAddress } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { retireWebSessionTabsSourceAddress } from '@/runtime/web-session-tabs-sync/source-address-retirement'
import { renameWorkspacePresentations } from '../../../../../../shared/workspace-presentation-intent'
import {
  workspacePresentationFor,
  noteWorkspacePresentationChanges
} from '../../../workspace-source-state'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { migrateHugeRepoWarningDismissal } from '@/lib/source-control-huge-repo-warning-dismissals'
import { migrateHostedReviewLinkMutationGeneration } from '../metadata/hosted-review-link-mutation'
import { buildWorktreeRenameState } from './worktree-identity-rename-state'

export function createMigrateWorktreeIdentity(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['migrateWorktreeIdentity'] {
  return (oldWorktreeId: string, newWorktreeId: string) => {
    if (oldWorktreeId === newWorktreeId) {
      return
    }
    // Why: invalidate pre-rename toast actions before publishing the new path, carrying the dismissal forward.
    migrateHugeRepoWarningDismissal(oldWorktreeId, newWorktreeId)
    set((s) => {
      const patch = buildWorktreeRenameState(s, oldWorktreeId, newWorktreeId)
      const saved = workspacePresentationFor(s, oldWorktreeId)
      const source = saved?.baseline.find(
        (base) => base.source.workspaceId === oldWorktreeId
      )?.source
      if (source && s.workspacePresentations) {
        if (source.hostId === 'local') {
          retireLocalSourceAddress(oldWorktreeId)
        } else if (source.hostId.startsWith('runtime:')) {
          retireWebSessionTabsSourceAddress(source.hostId.slice('runtime:'.length), oldWorktreeId)
        }
        const renamed = renameWorkspacePresentations(
          s.workspacePresentations,
          source,
          newWorktreeId
        )
        if (renamed.keys.length) {
          noteWorkspacePresentationChanges(renamed.documents, renamed.keys)
          patch.workspacePresentations = renamed.documents
        }
      }
      return Object.keys(patch).length > 0 ? patch : s
    })
    migrateHostedReviewLinkMutationGeneration(oldWorktreeId, newWorktreeId)
  }
}
