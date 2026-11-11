import {
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorkspaceMetadataSet } from '../../../../../../shared/worktree/workspace-metadata-set'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { getWorkspaceReferenceIdentity } from '../../../../../../shared/workspace-attachments/workspace-reference-identity'
import type { AppState } from '../../../types'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'

/** Where a record came from: this app's own main, or a paired host's runtime event stream. */
export type MetadataSetSource = { kind: 'local' } | { kind: 'environment'; environmentId: string }

// The row a record names, by its own execution host; a paired host's SSH twin is a different row.
function rowMatcher(
  state: AppState,
  set: WorkspaceMetadataSet,
  source: MetadataSetSource
): (row: Worktree) => boolean {
  if (source.kind === 'local') {
    const options = worktreeHostMatchOptions(state, set.repoId, set.hostId)
    return (row) => row.id === set.worktreeId && worktreeMatchesHost(row, set.hostId, options)
  }
  const environmentHost = toRuntimeExecutionHostId(source.environmentId)
  const options = worktreeHostMatchOptions(state, set.repoId, environmentHost)
  const sshHost = parseExecutionHostId(set.hostId)?.kind === 'ssh' ? set.hostId : null
  return (row) =>
    row.id === set.worktreeId &&
    worktreeMatchesHost(row, environmentHost, options) &&
    (sshHost ? row.hostId === sshHost : parseExecutionHostId(row.hostId ?? null)?.kind !== 'ssh')
}

/**
 * Fills a producer's addressed `workspaceMetadata` record into the row it names. The only producer
 * today saves issue titles, so only still-untitled links with the same identity take a title; the
 * record's links never replace the row's. `applied` is false when the row or link isn't listed yet.
 */
export function patchWorktreeMetadataSet(
  state: AppState,
  set: WorkspaceMetadataSet,
  source: MetadataSetSource
): { patch: Pick<AppState, 'worktreesByRepo'> | null; applied: boolean } {
  const titles = new Map<string, string>()
  for (const item of set.row.linkedItems ?? []) {
    const title = item.title?.trim()
    if (item.provider === 'github' && item.type === 'issue' && title) {
      titles.set(getWorkspaceReferenceIdentity(item), title)
    }
  }
  const rows = selectWorktreesByRepo(state)[set.repoId]
  const index = titles.size > 0 && rows ? rows.findIndex(rowMatcher(state, set, source)) : -1
  if (!rows || index === -1) {
    return { patch: null, applied: titles.size === 0 }
  }
  const seen = new Set<string>()
  let filled = false
  const linkedItems = getWorkspaceAttachments(rows[index]).map((item) => {
    const identity = getWorkspaceReferenceIdentity(item)
    const title = titles.get(identity)
    if (!title) {
      return item
    }
    seen.add(identity)
    if (item.title?.trim()) {
      return item
    }
    filled = true
    return { ...item, title }
  })
  // Every titled link must be listed here; one that isn't needs a listing that includes it.
  const applied = seen.size === titles.size
  if (!filled) {
    return { patch: null, applied }
  }
  const next = rows.slice()
  next[index] = { ...rows[index], linkedItems }
  return {
    patch: { worktreesByRepo: { ...selectWorktreesByRepo(state), [set.repoId]: next } },
    applied
  }
}
