import {
  formatSubmodulePushFailureDetail,
  GIT_FAILURE_DETAIL_ELISION_MARKER,
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

// Why: git's own lines usually end in a period, and the "…. Check your remote access" templates below
// append their own — without this the toast reads "Permission denied (publickey)..".
function withoutTrailingPeriod(detail: string): string {
  return detail.endsWith('.') ? detail.slice(0, -1) : detail
}

/** Electron wraps every rejected `ipcMain.handle` before the renderer sees it, on the first line only. */
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/
/** Node's execFile rejection preamble names the argv Orca ran, so such a line is never git's own reason. */
const COMMAND_PREAMBLE_LINE = /Command failed:/
/**
 * The one `fatal:` that diagnoses nothing: it says git never got to talk to the remote, and hands the
 * question upstream to whatever did the talking. Every other `fatal:` is git's own finding, reached
 * over a transport that worked, so nothing ssh printed before it can outrank it. Kept to this single
 * verdict deliberately: it is the only one where ssh is guaranteed to have stated its own reason last
 * (a denial, a refused connection, a host-key failure), so deferring cannot surface a bare advisory.
 */
const GIT_DEFERS_TO_TRANSPORT = /^Could not read from remote repository/i

// Why: a detail is either something to show or nothing at all. An empty string is neither — it
// survives every `??` below and reaches the user as a blank toast, which says less than a generic one.
function emptyToNull(detail: string): string | null {
  return detail.length > 0 ? detail : null
}

function extractPublishFailureDetail(message: string): string | null {
  let remoteDetail: string | null = null
  let causeBeforeFatal: string | null = null

  for (const rawLine of iterateRemoteErrorLines(message)) {
    const line = rawLine.trim().replace(IPC_INVOKE_PREFIX, '')
    if (!line) {
      continue
    }
    if (line.startsWith('fatal:')) {
      // Why: whose finding this is, not where it sits. git defers to the transport only when its own
      // verdict is the "never delivered" wrapper; then the reason is the transport's last word above.
      // Otherwise git reached the remote and diagnosed the failure itself, and ssh's preamble is noise
      // that carries identity-file and known_hosts paths out of the user's home.
      const verdict = line.slice('fatal:'.length).trim()
      return (
        (GIT_DEFERS_TO_TRANSPORT.test(verdict) ? causeBeforeFatal : null) ??
        emptyToNull(truncateDetail(stripCredentialsFromMessage(verdict)))
      )
    }
    if (line.startsWith('remote:')) {
      // Why: a bare `remote:` with nothing after it is not a detail — `??=` would latch the empty
      // string and every `?? fallback` below would then keep it, blanking the toast.
      remoteDetail ??= emptyToNull(
        truncateDetail(stripCredentialsFromMessage(line.slice('remote:'.length).trim()))
      )
      continue
    }
    // Why: only git's own local transport lines count as the cause. `remote:` is server chatter
    // (progress, policy notes) that git's `fatal:` verdict should still outrank, a wrapper preamble
    // names Orca's argv rather than anything git reported, and the elision marker is our own
    // truncation bookkeeping — showing it as the reason tells the user nothing at all.
    if (!COMMAND_PREAMBLE_LINE.test(line) && line !== GIT_FAILURE_DETAIL_ELISION_MARKER) {
      // Why: the *last* such line, not the first — within the transport's own output. ssh states its
      // verdict as it gives up, after every advisory it had to offer (`no such identity: <home
      // path>`, `Load key "<home path>": bad permissions`, the changed-host-key banner).
      causeBeforeFatal = truncateDetail(stripCredentialsFromMessage(line))
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

// Why: the last resort when no line stood out — and still a line, never the blob. git's closing
// diagnostic is last; everything above it can be ssh's preamble, which names files under the user's
// home. Electron's `Error invoking remote method …` wrapper is Orca's own framing, never git's, so it
// is stripped here the same way the line scan strips it.
function rawMessageDetail(message: string): string | null {
  const scrubbed = stripCredentialsFromMessage(message.replace(IPC_INVOKE_PREFIX, ''))
  let lastDiagnostic = ''
  for (const rawLine of iterateRemoteErrorLines(scrubbed)) {
    const line = rawLine.trim()
    if (line && line !== GIT_FAILURE_DETAIL_ELISION_MARKER) {
      lastDiagnostic = line
    }
  }
  return emptyToNull(truncateDetail(lastDiagnostic))
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

// Why: shared patterns so unconcluded-merge vs fresh-conflict toast copy cannot
// drift between the two branches below.
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
      return `Publish Branch failed. ${withoutTrailingPeriod(detail)}. Check your remote access and try again.`
    }

    return 'Publish Branch failed. Check your remote access and try again.'
  }

  if (options?.isSync) {
    // Why: the user invoked Sync — surface "Sync failed" rather than leaking
    // the inner-step name ("Push failed"). Detail extraction matches push so
    // auth / protected-branch reasons stay actionable.
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Sync failed. ${withoutTrailingPeriod(detail)}. Check your remote access and try again.`
    }
    return 'Sync failed. Check your connection and try again.'
  }

  if (options?.isForcePush) {
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Force Push failed. ${withoutTrailingPeriod(detail)}. Check your remote access and try again.`
    }
    return 'Force Push failed. Check your connection and try again.'
  }

  if (options?.isPush) {
    // Why: surfacing fatal/remote lines from git is more actionable than a generic
    // connection message for auth errors, protected branches, etc.
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Push failed. ${withoutTrailingPeriod(detail)}. Check your remote access and try again.`
    }
    return 'Push failed. Check your connection and try again.'
  }

  if (options?.isFetch) {
    const detail = extractPublishFailureDetail(error.message) ?? rawMessageDetail(error.message)
    return detail ? `Fetch failed. ${detail}` : 'Fetch failed. Check your connection and try again.'
  }

  if (options?.isFastForward) {
    const detail = extractPublishFailureDetail(error.message) ?? rawMessageDetail(error.message)
    return detail
      ? `Fast-forward failed. ${detail}`
      : 'Fast-forward failed. Check your connection and try again.'
  }

  if (options?.isRebase) {
    const detail = extractPublishFailureDetail(error.message) ?? rawMessageDetail(error.message)
    return detail
      ? `Rebase failed. ${detail}`
      : 'Rebase failed. Check your connection and try again.'
  }

  // Why: unlabeled callers (Pull) share the toast's one-line budget, and git output reaching here is
  // multi-line, so pick the same actionable line the labeled operations do instead of dumping the blob.
  return (
    extractPublishFailureDetail(error.message) ??
    rawMessageDetail(error.message) ??
    REMOTE_OPERATION_FAILED_MESSAGE
  )
}

export { isNonFastForwardRemoteError }
