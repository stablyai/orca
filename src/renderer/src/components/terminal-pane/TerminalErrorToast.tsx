import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { resolveClientEnvironmentFooter } from '@/lib/client-environment-info'
import { hasClientEnvironmentFooter } from '../../../../shared/client-environment-info'

const SSH_PREFIX = 'SSH connection is not active'
// Produced by pty-connection.ts reportError() when a PTY reattach can't reach its SSH host.
const SSH_CONNECT_FAILURE_PREFIX = 'SSH connection failed'
// Matched with includes(): this arrives IPC-wrapped ("Error invoking remote method 'pty:…': Error: …").
const SSH_RELAY_LOST_MARKER = 'SSH connection lost, reconnecting'
const STALE_NODE_PTY_DAEMON_MARKERS = [
  "Daemon's node-pty install is gone",
  'node-pty: posix_spawn failed: ENOENT'
]
const STALE_DAEMON_CWD_MARKERS = [
  "Daemon's working directory is gone",
  'node-pty: daemon_cwd failed: ENOENT'
]
// Thrown by ipc/pty.ts when a persisted pane owner can't be proven alive or dead (STA-3536).
const PANE_OWNER_UNVERIFIED_MARKER = 'terminal_pane_owner_unverified'
// Why one source: the test and replace forms must match the same token, and a lone /g regex carries
// lastIndex state across .test() calls. Capture the leading boundary so replacement can restore it.
const TERMINAL_HOST_GONE_SOURCE = '(^|[^a-z0-9_])terminal_host_gone(?=$|[^a-z0-9_])'
const TERMINAL_HOST_GONE_PATTERN = new RegExp(TERMINAL_HOST_GONE_SOURCE)
const TERMINAL_HOST_GONE_REPLACE_PATTERN = new RegExp(TERMINAL_HOST_GONE_SOURCE, 'g')
const LEGACY_TERMINAL_HOST_GONE_PATTERN =
  /(^|[^a-z])connect (?:ENOENT|ECONNREFUSED) [^\r\n]*orca-terminal-host-v[^\r\n]*/i
// A reattach the host answered "no such session" for: the SSH provider's expiry token, or the relay's
// raw not-found string when nothing mapped it. Both carry an internal PTY id, and neither is proof the
// remote shell died — the copy says only that this pane lost its session. Same lastIndex hazard as above.
const UNREATTACHABLE_SESSION_SOURCES = [
  'SSH_SESSION_EXPIRED:[ \\t]*\\S*(?:[ \\t]+SSH_PTY_IDENTITY_MISMATCH)?',
  'PTY "[^"\\r\\n]*" not found(?: \\(identity mismatch\\))?'
]
const UNREATTACHABLE_SESSION_PATTERNS = UNREATTACHABLE_SESSION_SOURCES.map(
  (source) => new RegExp(source)
)
const UNREATTACHABLE_SESSION_REPLACE_PATTERNS = UNREATTACHABLE_SESSION_SOURCES.map(
  (source) => new RegExp(source, 'g')
)

function isSshError(error: string): boolean {
  return isSshReconnectOwnedTerminalError(error)
}

/** A single error line the SSH reconnect banner already covers — hide instead of stacking under/over it. */
export function isSshReconnectOwnedTerminalError(error: string): boolean {
  return (
    error.startsWith(SSH_CONNECT_FAILURE_PREFIX) ||
    error.startsWith(SSH_PREFIX) ||
    error.includes(SSH_RELAY_LOST_MARKER)
  )
}

// Why: onPtyError aggregates errors into one newline-joined string, so classify per line —
// drop only the reconnect-owned lines and keep any unrelated error, regardless of order.
export function stripSshReconnectOwnedErrorLines(error: string): string | null {
  const kept = error
    .split('\n')
    .filter((line) => !isSshReconnectOwnedTerminalError(line))
    .join('\n')
  return kept.length > 0 ? kept : null
}

export function shouldOfferDaemonRestart(error: string): boolean {
  return [STALE_NODE_PTY_DAEMON_MARKERS, STALE_DAEMON_CWD_MARKERS].some((markers) =>
    markers.every((marker) => error.includes(marker))
  )
}

export function isExplainedTerminalError(error: string): boolean {
  return error
    .split('\n')
    .some(
      (line) =>
        TERMINAL_HOST_GONE_PATTERN.test(line) ||
        LEGACY_TERMINAL_HOST_GONE_PATTERN.test(line) ||
        UNREATTACHABLE_SESSION_PATTERNS.some((pattern) => pattern.test(line))
    )
}

function humanizeUnreattachableSession(error: string): string {
  const explanation = translate(
    'auto.components.terminal.pane.TerminalErrorToast.sessionUnavailable',
    "Orca couldn't reattach to this pane's terminal session on the host. Open a new terminal to continue."
  )
  // Why a replacer: a translation containing `$&` or `$1` would otherwise be read as a substitution.
  return UNREATTACHABLE_SESSION_REPLACE_PATTERNS.reduce(
    (message, pattern) => message.replace(pattern, () => explanation),
    error
  )
}

/** Swaps raw daemon-boundary codes for copy a user can act on. */
export function humanizeTerminalError(error: string): string {
  let humanized = error
  if (humanized.includes(PANE_OWNER_UNVERIFIED_MARKER)) {
    humanized = humanized.replace(
      PANE_OWNER_UNVERIFIED_MARKER,
      translate(
        'auto.components.terminal.pane.TerminalErrorToast.7ee11bc0db',
        "Orca couldn't confirm whether this terminal's previous session is still running, so it left the session untouched. Reopen this pane to retry."
      )
    )
  }
  humanized = humanizeUnreattachableSession(humanized)
  if (!isExplainedTerminalError(humanized)) {
    return humanized
  }
  const explanation = translate(
    'auto.components.terminal.pane.TerminalErrorToast.e16012e31e',
    'The terminal daemon that owned this session exited, so the session and its scrollback could not be recovered. Open a new terminal to continue.'
  )
  return humanized
    .split('\n')
    .map((line) =>
      line
        .replace(TERMINAL_HOST_GONE_REPLACE_PATTERN, (_match, prefix: string) =>
          prefix.concat(explanation)
        )
        .replace(LEGACY_TERMINAL_HOST_GONE_PATTERN, (_match, prefix: string) =>
          prefix.concat(explanation)
        )
    )
    .join('\n')
}

export function TerminalErrorToast({
  error,
  onDismiss,
  onRestartDaemon
}: {
  error: string
  onDismiss: () => void
  onRestartDaemon?: () => void
}): React.JSX.Element {
  const ssh = isSshError(error)
  const showDaemonRestart = !ssh && onRestartDaemon && shouldOfferDaemonRestart(error)
  // Restart cannot recover a session after its owning daemon exits.
  const showIssueLink = !ssh && !showDaemonRestart && !isExplainedTerminalError(error)
  const displayError = humanizeTerminalError(error)
  const [environmentFooter, setEnvironmentFooter] = useState<{
    error: string
    footer: string
  } | null>(null)

  // Why: a select-all copy should carry details loaded asynchronously from preload.
  useEffect(() => {
    if (ssh || hasClientEnvironmentFooter(displayError)) {
      return
    }
    let cancelled = false
    void resolveClientEnvironmentFooter().then((footer) => {
      if (!cancelled) {
        setEnvironmentFooter({ error: displayError, footer })
      }
    })
    return () => {
      cancelled = true
    }
  }, [displayError, ssh])

  const footer = environmentFooter?.error === displayError ? environmentFooter.footer : ''

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        right: 12,
        zIndex: 50,
        padding: '10px 14px',
        borderRadius: 6,
        background: ssh ? 'rgba(234, 179, 8, 0.12)' : 'rgba(220, 38, 38, 0.15)',
        border: ssh ? '1px solid rgba(234, 179, 8, 0.35)' : '1px solid rgba(220, 38, 38, 0.4)',
        color: ssh ? '#fde68a' : '#fca5a5',
        fontSize: 12,
        fontFamily: 'monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'auto'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <span style={{ minWidth: 0 }}>
          {displayError}
          {showDaemonRestart ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorToast.cc6d997c65',
                'Restart the terminal daemon from here to clear stale daemon state.'
              )}
            </>
          ) : showIssueLink ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorToast.5c8ce20be6',
                'If this persists, please'
              )}{' '}
              <a
                href="https://github.com/stablyai/orca/issues"
                style={{ color: '#fca5a5', textDecoration: 'underline' }}
              >
                {translate(
                  'auto.components.terminal.pane.TerminalErrorToast.a7e2fd2699',
                  'file an issue'
                )}
              </a>
              .
            </>
          ) : null}
          {!ssh && footer ? `\n\n${footer}` : null}
        </span>
        {showDaemonRestart ? (
          <button
            onClick={onRestartDaemon}
            style={{
              marginLeft: 12,
              border: '1px solid rgba(252, 165, 165, 0.45)',
              borderRadius: 6,
              background: 'rgba(127, 29, 29, 0.35)',
              color: '#fecaca',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 8px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            {translate(
              'auto.components.terminal.pane.TerminalErrorToast.e4aa243f8c',
              'Restart daemon'
            )}
          </button>
        ) : null}
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: ssh ? '#fde68a' : '#fca5a5',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 0 0 8px',
            lineHeight: 1,
            flexShrink: 0
          }}
        >
          ×
        </button>
      </div>
    </div>
  )
}
