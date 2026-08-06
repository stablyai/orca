import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'

// Why: a runtime lacking browser.screencast.v1 will not grow it while this connection lives, so
// retrying that failure is unbounded work with a visible error each round. Tagged rather than
// message-matched so a reworded string cannot silently turn it back into an infinite retry.
export const REMOTE_BROWSER_STREAM_UNSUPPORTED = 'remote_browser_stream_unsupported'

// Why: the runtime answers with these when the thing the stream is anchored to is gone from the
// host (worktree deleted, repo unregistered, capability absent). Retrying cannot bring it back, so
// they are permanent for this connection exactly like the capability tag above. Codes come from
// src/main/runtime/rpc/errors.ts rather than being invented here.
const REMOTE_BROWSER_STREAM_TARGET_GONE_CODES: ReadonlySet<string> = new Set([
  'selector_not_found',
  'worktree_not_found_on_server',
  'repo_not_found',
  'capability_unsupported'
])

const REMOTE_BROWSER_PAGE_MISSING_CODES: ReadonlySet<string> = new Set([
  'browser_tab_not_found',
  'browser_no_tab'
])

export function remoteBrowserStreamUnsupportedError(): Error {
  return Object.assign(
    new Error('The selected runtime does not support remote browser streaming.'),
    { code: REMOTE_BROWSER_STREAM_UNSUPPORTED }
  )
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

export function isRemoteBrowserStreamUnsupportedError(error: unknown): boolean {
  return readErrorCode(error) === REMOTE_BROWSER_STREAM_UNSUPPORTED
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
