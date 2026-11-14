import { normalizeExecutionHostId, type ExecutionHostId } from '../../execution-host'
import { normalizeStoredTaskSourceContext } from '../../work-items/task-source-context'
import { normalizeWorkspaceAttachments } from '../../workspace-attachments/workspace-attachment-normalization'
import { normalizeWorkspaceLinkedItem } from '../../workspace-attachments/workspace-linked-item'
import type { WorktreeMeta } from '../meta-types'

/** A producer's `workspaceMetadata` position: records with `seq` at or below it are in what it read. */
export type WorkspaceMetadataCursor = { epoch: string; seq: number }

/** The workspace-metadata fields a producer publishes today; the row widens without changing the envelope. */
export type WorkspaceMetadataSetRow = Pick<
  WorktreeMeta,
  'linkedItems' | 'linkedWorkItem' | 'linkedIssue' | 'linkedTaskSourceContext'
>

/**
 * One addressed `set` record in a producer host's `workspaceMetadata` domain: full current values for one
 * workspace, ordered by `seq` within `epoch`. A gap, a new epoch or an unknown row falls back to the listing.
 */
export type WorkspaceMetadataSet = {
  kind: 'set'
  domain: 'workspaceMetadata'
  hostId: ExecutionHostId
  epoch: string
  seq: number
  // Host-qualified worktree identity; repoId and worktreeId route it to the client's listing.
  id: string
  repoId: string
  worktreeId: string
  row: WorkspaceMetadataSetRow
}

export function workspaceMetadataSetRow(meta: WorktreeMeta): WorkspaceMetadataSetRow {
  return {
    linkedItems: meta.linkedItems,
    linkedWorkItem: meta.linkedWorkItem,
    linkedIssue: meta.linkedIssue,
    linkedTaskSourceContext: meta.linkedTaskSourceContext
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A well-formed record, or null when an older or malformed producer sent something else. */
export function readWorkspaceMetadataSet(value: unknown): WorkspaceMetadataSet | null {
  if (!isRecord(value) || !isRecord(value.row)) {
    return null
  }
  const { kind, domain, epoch, seq, id, repoId, worktreeId, row } = value
  const hostId = normalizeExecutionHostId(typeof value.hostId === 'string' ? value.hostId : null)
  if (
    kind !== 'set' ||
    domain !== 'workspaceMetadata' ||
    !hostId ||
    typeof epoch !== 'string' ||
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    typeof id !== 'string' ||
    typeof repoId !== 'string' ||
    typeof worktreeId !== 'string' ||
    !Array.isArray(row.linkedItems) ||
    (row.linkedIssue !== null && typeof row.linkedIssue !== 'number')
  ) {
    return null
  }
  return {
    kind,
    domain,
    hostId,
    epoch,
    seq,
    id,
    repoId,
    worktreeId,
    row: {
      linkedItems: normalizeWorkspaceAttachments(row.linkedItems),
      linkedWorkItem: normalizeWorkspaceLinkedItem(row.linkedWorkItem),
      linkedIssue: row.linkedIssue,
      linkedTaskSourceContext: normalizeStoredTaskSourceContext(row.linkedTaskSourceContext)
    }
  }
}
