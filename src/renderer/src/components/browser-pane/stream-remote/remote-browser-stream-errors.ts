import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../../../../shared/runtime-session-contracts'
import {
  remoteBrowserStreamLostNotice,
  remoteBrowserStreamRestartFailedNotice,
  remoteBrowserStreamUnsupportedNotice,
  remoteBrowserStreamUnreachableNotice,
  remoteBrowserServiceUnavailableNotice
} from './remote-browser-stream-status'

// Why: a missing capability never appears mid-connection; tagged so a reworded message can't restore infinite retry.
const REMOTE_BROWSER_STREAM_UNSUPPORTED = 'remote_browser_stream_unsupported'

// Why: host says the anchor itself is gone (codes from src/main/runtime/rpc/errors.ts); retrying can't restore it.
// selector_not_found is deliberately excluded: a slow 1s-TTL worktree scan can emit it transiently.
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
  const code = error.code
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

export type RemoteBrowserStreamFailure = {
  /** What the pane shows. */
  message: string
  /** False once the failure is proven unrecoverable on this connection. */
  shouldRetry: boolean
  /** Whether the raw error is worth logging — true only when the pane replaced the message. */
  logRawError: boolean
}

// Why: a classified permanent failure keeps its own specific message; others get a pane-authored notice and the raw error is logged. Whether to offer reconnect is decided by status, not here.
export function resolveRemoteBrowserStreamFailure(
  error: unknown,
  phase: 'opening' | 'restart' = 'restart'
): RemoteBrowserStreamFailure {
  // Browser setup can recover without the server connection changing.
  if (readErrorCode(error) === BROWSER_UNAVAILABLE_ERROR_CODE) {
    return {
      message: remoteBrowserServiceUnavailableNotice(),
      shouldRetry: true,
      logRawError: true
    }
  }
  if (isPermanentRemoteBrowserStreamFailure(error)) {
    return {
      message: error instanceof Error ? error.message : remoteBrowserStreamRestartFailedNotice(),
      shouldRetry: false,
      logRawError: false
    }
  }
  return {
    message:
      phase === 'opening'
        ? remoteBrowserStreamUnreachableNotice()
        : remoteBrowserStreamLostNotice(),
    shouldRetry: true,
    logRawError: true
  }
}
