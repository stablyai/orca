import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import {
  remoteBrowserStreamLostNotice,
  remoteBrowserStreamRestartFailedNotice,
  remoteBrowserStreamUnsupportedNotice
} from './remote-browser-stream-status'

// Why: a runtime lacking browser.screencast.v1 will not grow it while this connection lives, so
// retrying that failure is unbounded work with a visible error each round. Tagged rather than
// message-matched so a reworded string cannot silently turn it back into an infinite retry.
export const REMOTE_BROWSER_STREAM_UNSUPPORTED = 'remote_browser_stream_unsupported'

// Why: the runtime answers with these when the thing the stream is anchored to is gone from the
// host (worktree deleted, repo unregistered, capability absent). Retrying cannot bring it back, so
// they are permanent for this connection exactly like the capability tag above. Codes come from
// src/main/runtime/rpc/errors.ts rather than being invented here.
// Why `selector_not_found` is NOT here: it means "I could not resolve this right now", which is
// UNKNOWN, not proof the target is gone. Its producer is a live worktree scan behind a 1s-TTL cache,
// and the connectionId-gated fallback that shields SSH repos from scan lag does not cover purely
// local ones — so a slow scan can surface it transiently. Treating that as permanent would strand
// the pane forever, which is the exact bug this file exists to prevent. The three below are
// unambiguous: the host is telling us the thing itself no longer exists.
const REMOTE_BROWSER_STREAM_TARGET_GONE_CODES: ReadonlySet<string> = new Set([
  'worktree_not_found_on_server',
  'repo_not_found',
  'capability_unsupported'
])

const REMOTE_BROWSER_PAGE_MISSING_CODES: ReadonlySet<string> = new Set([
  'browser_tab_not_found',
  'browser_no_tab'
])

export function remoteBrowserStreamUnsupportedError(): Error {
  return Object.assign(new Error(remoteBrowserStreamUnsupportedNotice()), {
    code: REMOTE_BROWSER_STREAM_UNSUPPORTED
  })
}

function readErrorCode(error: unknown): string | null {
  if (error instanceof RuntimeRpcCallError) {
    return error.code
  }
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null
  }
  const code = (error as { code: unknown }).code
  return typeof code === 'string' ? code : null
}

export function isRemoteBrowserPageMissingCode(code: unknown): boolean {
  return typeof code === 'string' && REMOTE_BROWSER_PAGE_MISSING_CODES.has(code)
}

export function isRemoteBrowserPageMissingError(error: unknown): boolean {
  return isRemoteBrowserPageMissingCode(readErrorCode(error))
}

// Why: restart retries must stop for failures the host cannot recover from on its own; anything
// else is unproven and must keep retrying rather than strand the pane with a dead subscription.
export function isPermanentRemoteBrowserStreamFailure(error: unknown): boolean {
  const code = readErrorCode(error)
  if (code === null) {
    return false
  }
  return (
    code === REMOTE_BROWSER_STREAM_UNSUPPORTED || REMOTE_BROWSER_STREAM_TARGET_GONE_CODES.has(code)
  )
}

export type RemoteBrowserStreamRestartFailure = {
  /** What the pane shows. */
  message: string
  /** False once the failure is proven unrecoverable on this connection. */
  shouldRetry: boolean
  /** Whether the raw error is worth logging — true only when the pane replaced the message. */
  logRawError: boolean
}

// Why the message is decided here rather than at the call site: whether a failure is permanent and
// what the user should be told are the same judgement. A permanent failure is one we classified and
// understand, so its own message says something true and specific ("The selected runtime does not
// support remote browser streaming."); flattening that to "Lost connection" would be vaguer and
// wrong, since nothing was lost. Everything else carries a raw transport string written for logs,
// so the pane speaks for itself there and the raw text is left to the caller to log.
//
// Note what this deliberately does NOT decide: whether the user is offered a way back. Stopping
// automatic retries and removing the user's only recovery are different things, and conflating them
// is what stranded the pane in the first place. `selector_not_found` already had to be walked back
// out of the permanent set once (08260a54bf) — proof this classification can be wrong — so a
// misjudgement here must stay recoverable by hand.
export function resolveRemoteBrowserStreamRestartFailure(
  error: unknown
): RemoteBrowserStreamRestartFailure {
  if (isPermanentRemoteBrowserStreamFailure(error)) {
    return {
      message: error instanceof Error ? error.message : remoteBrowserStreamRestartFailedNotice(),
      shouldRetry: false,
      logRawError: false
    }
  }
  return { message: remoteBrowserStreamLostNotice(), shouldRetry: true, logRawError: true }
}
