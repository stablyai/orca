import {
  GIT_AUTHENTICATION_FAILED_MESSAGE,
  formatSubmodulePushFailureDetail,
  stripCredentialsFromMessage
} from '../../../shared/git-remote-error'
import {
  isPushHookFailure,
  summarizePushFailure
} from '../../../shared/source-control-push-failure'

const REMOTE_OPERATION_FAILED_MESSAGE = 'Remote operation failed'
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
  operationLabel: string
): string | null {
  const detail = formatSubmodulePushFailureDetail(message)
  return detail ? `${operationLabel} failed. ${truncateDetail(detail)}` : null
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

// Share merge-error patterns so unconcluded/fresh-conflict wording stays consistent.
const UNCONCLUDED_MERGE_ERROR_PATTERN =
  /unmerged files|needs merge|you have not concluded your merge/i
const FRESH_MERGE_CONFLICT_ERROR_PATTERN = /automatic merge failed|CONFLICT \(|fix conflicts/i

export function resolveRemoteOperationErrorMessage(
  error: unknown,
  options?: RemoteOperationErrorOptions
): string {
  if (!(error instanceof Error)) {
    return REMOTE_OPERATION_FAILED_MESSAGE
  }

  if (UNCONCLUDED_MERGE_ERROR_PATTERN.test(error.message)) {
    if (options?.isRebase) {
      return 'Rebase blocked — resolve existing conflicts first.'
    }
    return options?.isSync
      ? 'Sync blocked — resolve existing merge conflicts first.'
      : 'Pull blocked — resolve existing merge conflicts first.'
  }

  if (FRESH_MERGE_CONFLICT_ERROR_PATTERN.test(error.message)) {
    if (options?.isRebase) {
      return 'Rebase stopped with conflicts. Resolve them in Source Control, then continue the rebase.'
    }
    return options?.isSync
      ? 'Sync stopped with merge conflicts. Resolve them in Source Control, then commit the merge.'
      : 'Pull stopped with merge conflicts. Resolve them in Source Control, then commit the merge.'
  }

  if (options?.publish) {
    const submoduleMessage = resolveSubmodulePushFailureMessage(error.message, 'Publish Branch')
    if (submoduleMessage) {
      return submoduleMessage
    }
  }

  if (options?.isSync) {
    const submoduleMessage = resolveSubmodulePushFailureMessage(error.message, 'Sync')
    if (submoduleMessage) {
      return submoduleMessage
    }
  }

  if (options?.isForcePush) {
    const submoduleMessage = resolveSubmodulePushFailureMessage(error.message, 'Force Push')
    if (submoduleMessage) {
      return submoduleMessage
    }
  }

  if (options?.isPush) {
    const submoduleMessage = resolveSubmodulePushFailureMessage(error.message, 'Push')
    if (submoduleMessage) {
      return submoduleMessage
    }
  }

  const isPushLikeOperation =
    options?.isPush || options?.isForcePush || options?.publish || options?.isSyncPushStage
  if (isPushLikeOperation && isPushHookFailure(error.message)) {
    const summary = summarizePushFailure(error.message)
    const operationLabel = options?.publish
      ? 'Publish Branch'
      : options?.isSyncPushStage
        ? 'Sync'
        : options?.isForcePush
          ? 'Force Push'
          : 'Push'
    return `${operationLabel} blocked — ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`
  }

  // Sync already pulled; NFF means the remote raced before its inner push. Choose sync wording before the shared push path, never misleading Pull first advice.
  if (
    options?.isSync &&
    /non-fast-forward|fetch first|updates were rejected/i.test(error.message)
  ) {
    return 'Sync failed — remote moved while syncing. Try again.'
  }

  // Lease rejection means remote changed since our snapshot; Pull first could reintroduce commits the explicit force-push meant to replace.
  if (
    options?.isForcePush &&
    /non-fast-forward|fetch first|updates were rejected|stale info/i.test(error.message)
  ) {
    return 'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
  }

  // Share rejected/NFF handling across publish and push for consistent actions.
  if (/non-fast-forward|fetch first|updates were rejected/i.test(error.message)) {
    return 'Push rejected — remote has changes. Pull first, then try again.'
  }

  // Collapse overwritten-worktree refusal to one line instead of listing every affected path in the toast.
  if (
    /local changes.*would be overwritten|Please commit your changes or stash them/i.test(
      error.message
    )
  ) {
    if (options?.isRebase) {
      return 'Rebase blocked — commit or stash your local changes first.'
    }
    if (options?.isFastForward) {
      return 'Fast-forward blocked — commit or stash your local changes first.'
    }
    return 'Pull blocked — commit or stash your local changes first.'
  }

  if (/Pull would overwrite local changes/i.test(error.message)) {
    if (options?.isRebase) {
      return 'Rebase blocked — commit or stash your local changes first.'
    }
    if (options?.isFastForward) {
      return 'Fast-forward blocked — commit or stash your local changes first.'
    }
    return 'Pull blocked — commit or stash your local changes first.'
  }

  if (/Pull would overwrite untracked files/i.test(error.message)) {
    if (options?.isRebase) {
      return 'Rebase blocked — move, remove, or add untracked files first.'
    }
    if (options?.isFastForward) {
      return 'Fast-forward blocked — move, remove, or add untracked files first.'
    }
    return 'Pull blocked — move, remove, or add untracked files first.'
  }

  // Why: the normalized auth message has no `fatal:` line and usually arrives IPC/RPC-wrapped.
  if (error.message.includes(GIT_AUTHENTICATION_FAILED_MESSAGE)) {
    const operationLabel = options?.publish
      ? 'Publish Branch'
      : options?.isSync
        ? 'Sync'
        : options?.isForcePush
          ? 'Force Push'
          : options?.isPush
            ? 'Push'
            : options?.isFetch
              ? 'Fetch'
              : options?.isFastForward
                ? 'Fast-forward'
                : options?.isRebase
                  ? 'Rebase'
                  : 'Pull'
    return `${operationLabel} failed. ${GIT_AUTHENTICATION_FAILED_MESSAGE}`
  }

  if (options?.publish) {
    // Unwrap publish git/IPC errors while preserving actionable fatal reasons.
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Publish Branch failed. ${detail}. Check your remote access and try again.`
    }

    return 'Publish Branch failed. Check your remote access and try again.'
  }

  if (options?.isSync) {
    // Sync reports its own failure, retaining push detail extraction for auth/protected-branch guidance.
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Sync failed. ${detail}. Check your remote access and try again.`
    }
    return 'Sync failed. Check your connection and try again.'
  }

  if (options?.isForcePush) {
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Force Push failed. ${detail}. Check your remote access and try again.`
    }
    return 'Force Push failed. Check your connection and try again.'
  }

  if (options?.isPush) {
    // Prefer git fatal/remote detail over generic connection messages for auth/protected-branch failures.
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Push failed. ${detail}. Check your remote access and try again.`
    }
    return 'Push failed. Check your connection and try again.'
  }

  if (options?.isFetch) {
    const detail =
      extractPublishFailureDetail(error.message) ??
      truncateDetail(stripCredentialsFromMessage(error.message))
    return `Fetch failed. ${detail}`
  }

  if (options?.isFastForward) {
    const detail =
      extractPublishFailureDetail(error.message) ??
      truncateDetail(stripCredentialsFromMessage(error.message))
    return `Fast-forward failed. ${detail}`
  }

  if (options?.isRebase) {
    const detail =
      extractPublishFailureDetail(error.message) ??
      truncateDetail(stripCredentialsFromMessage(error.message))
    return `Rebase failed. ${detail}`
  }

  return error.message
}

export { isNonFastForwardRemoteError }
