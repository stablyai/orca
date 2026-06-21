import {
  formatSubmodulePushFailureDetail,
  stripCredentialsFromMessage
} from '../../../shared/git-remote-error'

const REMOTE_OPERATION_FAILED_MESSAGE = 'Remote operation failed'
const REMOTE_OPERATION_DETAIL_MAX_LENGTH = 200

// Why: arbitrarily long git stderr lines (for instance, a multi-kilobyte
// server-side pre-receive hook message) should not blow up the toast. Cap the
// detail length so the toast stays readable; the underlying error is still
// rethrown for console/logs if a caller needs the full payload.
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
  isFetch?: boolean
  isFastForward?: boolean
  isRebase?: boolean
}

export function resolveRemoteOperationErrorMessage(
  error: unknown,
  options?: RemoteOperationErrorOptions
): string {
  if (!(error instanceof Error)) {
    return REMOTE_OPERATION_FAILED_MESSAGE
  }

  if (/unmerged files|needs merge|you have not concluded your merge/i.test(error.message)) {
    if (options?.isRebase) {
      return 'Rebase blocked — resolve existing conflicts first.'
    }
    return options?.isSync
      ? 'Sync blocked — resolve existing merge conflicts first.'
      : 'Pull blocked — resolve existing merge conflicts first.'
  }

  if (/automatic merge failed|CONFLICT \(|fix conflicts/i.test(error.message)) {
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

  // Why: under sync, the inner push runs *after* a successful pull, so a
  // non-fast-forward at that point means the remote raced ahead between
  // fetch and push — not "user forgot to pull". Saying "Pull first" would
  // be wrong (sync just did). Branch isSync above the shared NFF path so
  // sync gets a sync-shaped message instead of inheriting the push wording.
  if (
    options?.isSync &&
    /non-fast-forward|fetch first|updates were rejected/i.test(error.message)
  ) {
    return 'Sync failed — remote moved while syncing. Try again.'
  }

  // Why: force-with-lease rejection means the remote moved since our last
  // snapshot; telling the user to pull would defeat the explicit force-push
  // path and can reintroduce commits they meant to replace.
  if (
    options?.isForcePush &&
    /non-fast-forward|fetch first|updates were rejected|stale info/i.test(error.message)
  ) {
    return 'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
  }

  // Why: non-fast-forward/rejected detection is shared across publish and push so
  // both paths surface the same actionable toast regardless of operation type.
  if (/non-fast-forward|fetch first|updates were rejected/i.test(error.message)) {
    return 'Push rejected — remote has changes. Pull first, then try again.'
  }

  // Why: `git pull` / merge refuses to run when the working tree has changes
  // that would be overwritten; surface a single readable line instead of the
  // multi-line git stderr (which lists every affected path).
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

  if (options?.publish) {
    // Why: publish failures often bubble up as raw wrapped git/IPC payloads; this
    // keeps the toast human-readable while preserving the actionable fatal reason.
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Publish Branch failed. ${detail}. Check your remote access and try again.`
    }

    return 'Publish Branch failed. Check your remote access and try again.'
  }

  if (options?.isSync) {
    // Why: the user invoked Sync — surface "Sync failed" rather than leaking
    // the inner-step name ("Push failed"). Detail extraction matches push so
    // auth / protected-branch reasons stay actionable.
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
    // Why: surfacing fatal/remote lines from git is more actionable than a generic
    // connection message for auth errors, protected branches, etc.
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
