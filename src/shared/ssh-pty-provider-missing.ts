/**
 * The wire shape of a PTY-provider miss. Main formats it, the renderer matches the prefix
 * and, for runtime-owned targets, re-renders the detail with translated guidance instead of
 * surfacing the internal target id. `orca terminal create` and paired clients see main's
 * English text as-is, so it must stand on its own.
 */
export const SSH_PTY_PROVIDER_MISSING_PREFIX = 'No PTY provider for connection'

/** Runtime-owned targets have no host-list Reconnect; these are the retries the user has. */
export const RUNTIME_OWNED_SSH_RELAY_RETRY_HINT =
  'Open the workspace again or start a new terminal to retry.'
export const RUNTIME_OWNED_SSH_RELAY_NOT_ATTACHED =
  'the SSH relay for this workspace is not attached'
export const RUNTIME_OWNED_SSH_RELAY_REATTACH_FAILED_PREFIX =
  'the SSH relay for this workspace could not be re-attached: '

export function formatSshPtyProviderMissingError(connectionId: string, detail: string): string {
  return `${SSH_PTY_PROVIDER_MISSING_PREFIX} "${connectionId}": ${detail}`
}

/** The miss main raises when a runtime-owned target's relay is absent and nothing re-attached it. */
export function formatRuntimeOwnedSshRelayNotAttached(connectionId: string): string {
  return formatSshPtyProviderMissingError(
    connectionId,
    `${RUNTIME_OWNED_SSH_RELAY_NOT_ATTACHED}. ${RUNTIME_OWNED_SSH_RELAY_RETRY_HINT}`
  )
}

/** The miss main raises when the spawn-time re-attach itself failed; `cause` is the dial error. */
export function formatRuntimeOwnedSshRelayReattachFailed(
  connectionId: string,
  cause: string
): string {
  const trimmedCause = cause.trim().replace(/\.\s*$/, '')
  return formatSshPtyProviderMissingError(
    connectionId,
    `${RUNTIME_OWNED_SSH_RELAY_REATTACH_FAILED_PREFIX}${trimmedCause}. ${RUNTIME_OWNED_SSH_RELAY_RETRY_HINT}`
  )
}

export type RuntimeOwnedSshRelayMiss =
  | { kind: 'not-attached' }
  | { kind: 'reattach-failed'; cause: string }
  | { kind: 'other'; detail: string }

/**
 * Classifies a provider-miss message for a runtime-owned target so the renderer can render
 * translated copy without the internal id. Anything it does not recognise is passed through
 * as `other` with the detail main gave.
 */
export function parseRuntimeOwnedSshRelayMiss(message: string): RuntimeOwnedSshRelayMiss {
  const start = message.indexOf(SSH_PTY_PROVIDER_MISSING_PREFIX)
  const afterPrefix =
    start === -1 ? message : message.slice(start + SSH_PTY_PROVIDER_MISSING_PREFIX.length)
  const detailStart = afterPrefix.indexOf('": ')
  // Why: a bare `No PTY provider for connection "<id>"` (older main, no detail) is a plain miss.
  const rawDetail = detailStart === -1 ? '' : afterPrefix.slice(detailStart + 3)
  const detail = rawDetail
    .replace(RUNTIME_OWNED_SSH_RELAY_RETRY_HINT, '')
    .trim()
    .replace(/\.\s*$/, '')
  if (detail === RUNTIME_OWNED_SSH_RELAY_NOT_ATTACHED || detail === '') {
    return { kind: 'not-attached' }
  }
  if (detail.startsWith(RUNTIME_OWNED_SSH_RELAY_REATTACH_FAILED_PREFIX)) {
    return {
      kind: 'reattach-failed',
      cause: detail.slice(RUNTIME_OWNED_SSH_RELAY_REATTACH_FAILED_PREFIX.length)
    }
  }
  return { kind: 'other', detail }
}
