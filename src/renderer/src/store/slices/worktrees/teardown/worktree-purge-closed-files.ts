import type { AppState } from '../../../types'
import type { WorktreePurgeTarget } from '../../worktree-helpers'
import { collectRemovedHostTwinState } from '../../../repos/repo-removal-host-twin-attribution'
import { collectHostTwinPurgeScopes } from './host-twin-worktree-purge'

/** Match purge policy: host targets close only attributable editor tabs while another host still publishes the ID. */
export function worktreePurgeClosedFileIds(
  s: AppState,
  targets: readonly WorktreePurgeTarget[]
): Set<string> {
  const twinScopes = collectHostTwinPurgeScopes(s, targets)
  const twinIds = new Set([...twinScopes.values()].flatMap((twins) => [...twins.keys()]))
  const fullIds = new Set(
    targets.filter((target) => !target.hostId || !twinIds.has(target.id)).map((t) => t.id)
  )
  const closed = new Set<string>()
  for (const file of s.openFiles ?? []) {
    if (fullIds.has(file.worktreeId)) {
      closed.add(file.id)
      if (file.markdownPreviewSourceFileId) {
        closed.add(file.markdownPreviewSourceFileId)
      }
    }
  }
  for (const [hostId, twins] of twinScopes) {
    for (const id of collectRemovedHostTwinState(s, new Set(twins.keys()), hostId, twins).fileIds) {
      closed.add(id)
    }
  }
  return closed
}
