import { translate } from '@/i18n/i18n'
import {
  GIT_AUTHENTICATION_FAILED_MESSAGE,
  formatSubmodulePushFailureDetail,
  stripCredentialsFromMessage
} from '../../../shared/git-remote-error'
import {
  isPushHookFailure,
  summarizePushFailure
} from '../../../shared/source-control-push-failure'
import {
  type PullLikeOperation,
  type PushLikeOperation,
  type RemoteOperation,
  localChangesBlockedMessage,
  mergeConflictsMessage,
  operationFailedWithDetail,
  pushHookBlockedMessage,
  remoteAccessFailedMessage,
  translateSubmodulePushFailureDetail,
  untrackedFilesBlockedMessage
} from './source-control-remote-error-copy'

const REMOTE_OPERATION_DETAIL_MAX_LENGTH = 200
const SYNC_PUSH_STAGE_ERROR = Symbol('source-control-sync-push-stage-error')
type SyncPushStageMarkedError = Error & { [SYNC_PUSH_STAGE_ERROR]?: true }

// Cap toast details from unbounded git stderr; callers retain the rethrown full error for logs.
function truncateDetail(detail: string): string {
  if (detail.length <= REMOTE_OPERATION_DETAIL_MAX_LENGTH) {
    return detail
  }
  return `${detail.slice(0, REMOTE_OPERATION_DETAIL_MAX_LENGTH).trimEnd()}...`
}

function extractPublishFailureDetail(message: string): string | null {
  let remoteDetail: string | null = null

  for (const rawLine of iterateRemoteErrorLines(message)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    if (line.startsWith('fatal:')) {
      return truncateDetail(stripCredentialsFromMessage(line.slice('fatal:'.length).trim()))
    }
    if (remoteDetail === null && line.startsWith('remote:')) {
      remoteDetail = truncateDetail(
        stripCredentialsFromMessage(line.slice('remote:'.length).trim())
      )
    }
  }

  return remoteDetail
}

function* iterateRemoteErrorLines(message: string): Generator<string> {
  let lineStart = 0

  for (let index = 0; index < message.length; index++) {
    const code = message.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }

    yield message.slice(lineStart, index)
    if (code === 13 && message.charCodeAt(index + 1) === 10) {
      index++
    }
    lineStart = index + 1
  }

  if (lineStart <= message.length) {
    yield message.slice(lineStart)
  }
}

function resolveSubmodulePushFailureMessage(
  message: string,
  operation: PushLikeOperation
): string | null {
  const detail = translateSubmodulePushFailureDetail(message)
  return detail ? operationFailedWithDetail(operation, truncateDetail(detail)) : null
}

function isNonFastForwardRemoteError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return (
    /non-fast-forward|fetch first|updates were rejected|stale info/i.test(error.message) ||
    formatSubmodulePushFailureDetail(error.message)?.includes('has remote changes') === true
  )
}

export type RemoteOperationErrorOptions = {
  publish?: boolean
  isPush?: boolean
  isForcePush?: boolean
  isSync?: boolean
  isSyncPushStage?: boolean
  isFetch?: boolean
  isFastForward?: boolean
  isRebase?: boolean
}

export function markSyncPushStageError<T>(error: T): T {
  if (error instanceof Error) {
    Object.defineProperty(error, SYNC_PUSH_STAGE_ERROR, {
      configurable: true,
      value: true
    })
  }
  return error
}

export function isSyncPushStageError(error: unknown): boolean {
  return (
    error instanceof Error && (error as SyncPushStageMarkedError)[SYNC_PUSH_STAGE_ERROR] === true
  )
}

function unconcludedMergeMessage(operation: PullLikeOperation): string {
  if (operation === 'rebase') {
    return translate(
      'sourceControl.remoteError.unconcludedMerge.rebase',
      'Rebase blocked — resolve existing conflicts first.'
    )
  }
  return operation === 'sync'
    ? translate(
        'sourceControl.remoteError.unconcludedMerge.sync',
        'Sync blocked — resolve existing merge conflicts first.'
      )
    : translate(
        'sourceControl.remoteError.unconcludedMerge.pull',
        'Pull blocked — resolve existing merge conflicts first.'
      )
}

// Share merge-error patterns so unconcluded/fresh-conflict wording stays consistent.
const UNCONCLUDED_MERGE_ERROR_PATTERN =
  /unmerged files|needs merge|you have not concluded your merge/i
const FRESH_MERGE_CONFLICT_ERROR_PATTERN = /automatic merge failed|CONFLICT \(|fix conflicts/i

export function resolveRemoteOperationErrorMessage(
  error: unknown,
  options?: RemoteOperationErrorOptions
): string {
  if (!(error instanceof Error)) {
    return translate('sourceControl.remoteError.operationFailed', 'Remote operation failed')
  }

  const pullLikeOperation: PullLikeOperation = options?.isRebase
    ? 'rebase'
    : options?.isSync
      ? 'sync'
      : options?.isFastForward
        ? 'fastForward'
        : 'pull'

  if (UNCONCLUDED_MERGE_ERROR_PATTERN.test(error.message)) {
    return unconcludedMergeMessage(pullLikeOperation)
  }

  if (FRESH_MERGE_CONFLICT_ERROR_PATTERN.test(error.message)) {
    return mergeConflictsMessage(pullLikeOperation)
  }

  if (options?.publish) {
    const submoduleMessage = resolveSubmodulePushFailureMessage(error.message, 'publish')
    if (submoduleMessage) {
      return submoduleMessage
    }
  }

  if (options?.isSync) {
    const submoduleMessage = resolveSubmodulePushFailureMessage(error.message, 'sync')
    if (submoduleMessage) {
      return submoduleMessage
    }
  }

  if (options?.isForcePush) {
    const submoduleMessage = resolveSubmodulePushFailureMessage(error.message, 'forcePush')
    if (submoduleMessage) {
      return submoduleMessage
    }
  }

  if (options?.isPush) {
    const submoduleMessage = resolveSubmodulePushFailureMessage(error.message, 'push')
    if (submoduleMessage) {
      return submoduleMessage
    }
  }

  const isPushLikeOperation =
    options?.isPush || options?.isForcePush || options?.publish || options?.isSyncPushStage
  if (isPushLikeOperation && isPushHookFailure(error.message)) {
    const operation: PushLikeOperation = options?.publish
      ? 'publish'
      : options?.isSyncPushStage
        ? 'sync'
        : options?.isForcePush
          ? 'forcePush'
          : 'push'
    return pushHookBlockedMessage(operation, summarizePushFailure(error.message))
  }

  // Sync already pulled; NFF means the remote raced before its inner push. Choose sync wording before the shared push path, never misleading Pull first advice.
  if (
    options?.isSync &&
    /non-fast-forward|fetch first|updates were rejected/i.test(error.message)
  ) {
    return translate(
      'sourceControl.remoteError.syncRemoteMoved',
      'Sync failed — remote moved while syncing. Try again.'
    )
  }

  // Lease rejection means remote changed since our snapshot; Pull first could reintroduce commits the explicit force-push meant to replace.
  if (
    options?.isForcePush &&
    /non-fast-forward|fetch first|updates were rejected|stale info/i.test(error.message)
  ) {
    return translate(
      'sourceControl.remoteError.forcePushRejected',
      'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
    )
  }

  // Share rejected/NFF handling across publish and push for consistent actions.
  if (/non-fast-forward|fetch first|updates were rejected/i.test(error.message)) {
    return translate(
      'sourceControl.remoteError.pushRejected',
      'Push rejected — remote has changes. Pull first, then try again.'
    )
  }

  // Collapse overwritten-worktree refusal to one line instead of listing every affected path in the toast.
  if (
    /local changes.*would be overwritten|Please commit your changes or stash them/i.test(
      error.message
    )
  ) {
    return localChangesBlockedMessage(pullLikeOperation)
  }

  if (/Pull would overwrite local changes/i.test(error.message)) {
    return localChangesBlockedMessage(pullLikeOperation)
  }

  if (/Pull would overwrite untracked files/i.test(error.message)) {
    return untrackedFilesBlockedMessage(pullLikeOperation)
  }

  // Why: the normalized auth message has no `fatal:` line and usually arrives IPC/RPC-wrapped.
  if (error.message.includes(GIT_AUTHENTICATION_FAILED_MESSAGE)) {
    const operation: RemoteOperation = options?.publish
      ? 'publish'
      : options?.isSync
        ? 'sync'
        : options?.isForcePush
          ? 'forcePush'
          : options?.isPush
            ? 'push'
            : options?.isFetch
              ? 'fetch'
              : options?.isFastForward
                ? 'fastForward'
                : options?.isRebase
                  ? 'rebase'
                  : 'pull'
    return operationFailedWithDetail(
      operation,
      translate(
        'sourceControl.remoteError.authenticationFailed',
        'Authentication failed. Check your remote credentials.'
      )
    )
  }

  if (options?.publish) {
    // Unwrap publish git/IPC errors while preserving actionable fatal reasons.
    return remoteAccessFailedMessage('publish', extractPublishFailureDetail(error.message))
  }

  if (options?.isSync) {
    // Sync reports its own failure, retaining push detail extraction for auth/protected-branch guidance.
    return remoteAccessFailedMessage('sync', extractPublishFailureDetail(error.message))
  }

  if (options?.isForcePush) {
    return remoteAccessFailedMessage('forcePush', extractPublishFailureDetail(error.message))
  }

  if (options?.isPush) {
    // Prefer git fatal/remote detail over generic connection messages for auth/protected-branch failures.
    return remoteAccessFailedMessage('push', extractPublishFailureDetail(error.message))
  }

  const verbatimOperation: RemoteOperation | null = options?.isFetch
    ? 'fetch'
    : options?.isFastForward
      ? 'fastForward'
      : options?.isRebase
        ? 'rebase'
        : null
  if (verbatimOperation) {
    const detail =
      extractPublishFailureDetail(error.message) ??
      truncateDetail(stripCredentialsFromMessage(error.message))
    return operationFailedWithDetail(verbatimOperation, detail)
  }

  return error.message
}

export { isNonFastForwardRemoteError }
