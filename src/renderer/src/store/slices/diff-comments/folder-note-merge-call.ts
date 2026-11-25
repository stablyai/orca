import type {
  FolderDiffCommentMergeRequest,
  FolderDiffCommentReceipt
} from '../../../../../shared/file-review/folder-diff-comment-merge'
import { utf8JsonByteLength } from '../../../../../shared/file-review/folder-diff-comment-merge'
import {
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES,
  REMOTE_RUNTIME_REQUEST_ENVELOPE_RESERVE_BYTES
} from '../../../../../shared/remote-runtime/remote-runtime-memory-limits'
import { callHostRoute } from '@/runtime/rpc/calls/host-route-call'
import { hostRouteForAuthority } from '@/runtime/rpc/targets/runtime-client-target'
import {
  RuntimeConnectionChangedBeforeSendError,
  RuntimeRpcCallError
} from '@/runtime/rpc/calls/runtime-rpc-result'
import type { DiffCommentOwner } from './diff-comment-owner'

/** The largest params a paired host admits in one sealed frame, after the request envelope. */
export const FOLDER_NOTE_MERGE_MAX_PARAMS_BYTES =
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES - REMOTE_RUNTIME_REQUEST_ENVELOPE_RESERVE_BYTES

/** Refused on this computer before anything was sent. */
export class FolderNoteWriteNotSentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FolderNoteWriteNotSentError'
  }
}

// Answers from a receiver that refused before running the operation, so nothing was written.
const RECEIVER_REFUSAL_CODES = new Set(['method_not_found', 'invalid_argument', 'forbidden'])

/** Whether a failed call provably wrote nothing; anything else may have landed. */
export function isDefinitiveFolderNoteRefusal(err: unknown): boolean {
  return (
    err instanceof FolderNoteWriteNotSentError ||
    err instanceof RuntimeConnectionChangedBeforeSendError ||
    (err instanceof RuntimeRpcCallError && RECEIVER_REFUSAL_CODES.has(err.code)) ||
    (err instanceof Error &&
      err.message.includes('invalid_folder_workspace_merge_diff_comments_args'))
  )
}

/**
 * One merge-only note operation on the host that owns the folder's catalog. A paired host older than
 * this method answers method_not_found, so a recovering write can never become a list replacement.
 */
export async function mergeFolderDiffComments(
  owner: Extract<DiffCommentOwner, { kind: 'folder' }>,
  request: FolderDiffCommentMergeRequest,
  // Runs synchronously right before the request crosses to the host; throwing keeps it unsent.
  beforeSend?: () => void
): Promise<FolderDiffCommentReceipt> {
  if (!owner.runtimeEnvironmentId) {
    beforeSend?.()
    return window.api.folderWorkspaces.mergeDiffComments(request)
  }
  if (utf8JsonByteLength(request) > FOLDER_NOTE_MERGE_MAX_PARAMS_BYTES) {
    throw new FolderNoteWriteNotSentError('too large to send')
  }
  return callHostRoute<FolderDiffCommentReceipt>(
    // Why local: the folder's catalog row lives on the server even when it names an SSH target.
    hostRouteForAuthority({
      endpoint: { kind: 'environment', environmentId: owner.runtimeEnvironmentId },
      at: 'local'
    }),
    'folderWorkspace.mergeDiffComments',
    request,
    { timeoutMs: 15_000, beforeSend }
  )
}
