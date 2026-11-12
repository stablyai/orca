import { unwrapHostRefusalIpcLines } from './terminal-error-ipc-unwrap'
import { translate } from '../../../i18n/i18n'
import type { Translate } from '../../../i18n/use-translate'
import {
  humanizeFolderWorkspacePathErrors,
  isFolderWorkspacePathError
} from '../../../lib/workspace/paths/folder-workspace-path-status'
import { agentLaunchErrorText } from '../launch-outcome/agent-launch-pane-notice-text'
import { stripClientEnvironmentFooter } from '../../../../../shared/client-environment-info'
import { localizeTerminalSpawnHints } from './terminal-spawn-error-display'
import { localizeWslDistroHoldText } from '../../../runtime/hosts/wsl/wsl-distro-hold-copy'
import {
  describeSshSignInRequiredTerminalError,
  isSshSignInRequiredTerminalError
} from './terminal-ssh-sign-in-error'

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

// Main lost the pane to another connection twice in one attach, or an older host never retries.
const PANE_OWNER_CHANGED_MARKER = 'terminal_pane_owner_changed'

// The host still runs this terminal but could not read its history yet; the same ID can retry.
const TERMINAL_HISTORY_UNAVAILABLE_MARKER = 'terminal_history_unavailable'
// The same refusal before a fresh start: no process exists, so nothing is still running.
const TERMINAL_HISTORY_BEFORE_START_MARKER = 'terminal_history_unavailable_before_start'

// Keep the English transport literal as a wire marker; localize it here with the surrounding banner.
const REMOTE_TERMINAL_CLOSED_MARKER = 'Remote terminal was closed.'

// Why: a lone /g regex carries lastIndex across .test() calls, so each token gets a stateless test form and a /g replace form.
function tokenPattern(source: string): { match: RegExp; replaceAll: RegExp } {
  return { match: new RegExp(source), replaceAll: new RegExp(source, 'g') }
}

// Capture the leading boundary so replacement can restore it.
const TERMINAL_HOST_GONE = tokenPattern('(^|[^a-z0-9_])terminal_host_gone(?=$|[^a-z0-9_])')

const LEGACY_TERMINAL_HOST_GONE_PATTERN =
  /(^|[^a-z])connect (?:ENOENT|ECONNREFUSED) [^\r\n]*orca-terminal-host-v[^\r\n]*/i

// Session-absence responses from SSH, relay and older daemons prove only that this pane lost its session, not that the shell died.
const UNREATTACHABLE_SESSIONS = [
  'SSH_SESSION_EXPIRED:[ \\t]*\\S*(?:[ \\t]+SSH_PTY_IDENTITY_MISMATCH)?',
  'PTY "[^"\\r\\n]*" not found(?: \\(identity mismatch\\))?',
  '(?:SessionNotFoundError: )?Session not found: \\S+'
].map(tokenPattern)

// Retired delivery proves the shell is alive; separate it from missing sessions so the copy cannot tell users to abandon a running agent.
const SOURCE_RESTORE_REQUIRED = tokenPattern(
  'SSH_PTY_SOURCE_RESTORE_REQUIRED(?::[ \\t]*\\S*(?:[ \\t]+\\S+)?)?'
)

// The pane's saved session is owned by another host connection, e.g. an older build's relay tab.
const OWNER_HOST_MISMATCH = tokenPattern('terminal_pane_owner_host_mismatch')

/** A single error line the SSH reconnect banner already covers — hide instead of stacking under/over it. */
export function isSshReconnectOwnedTerminalError(error: string): boolean {
  return (
    error.startsWith(SSH_CONNECT_FAILURE_PREFIX) ||
    error.startsWith(SSH_PREFIX) ||
    error.includes(SSH_RELAY_LOST_MARKER)
  )
}

// Error messages are newline-joined for display, so keep unrelated lines regardless of order.
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
        LEGACY_TERMINAL_HOST_GONE_PATTERN.test(line) ||
        [
          TERMINAL_HOST_GONE,
          SOURCE_RESTORE_REQUIRED,
          OWNER_HOST_MISMATCH,
          ...UNREATTACHABLE_SESSIONS
        ].some((pattern) => pattern.match.test(line))
    )
}

/** The host no longer has this pane's terminal, so nothing can come back into it. */
export function isRemoteTerminalClosedError(error: string): boolean {
  return error.includes(REMOTE_TERMINAL_CLOSED_MARKER)
}

export function isPaneOwnerUnverifiedError(error: string): boolean {
  const lines = error.split('\n').filter((line) => line.length > 0)
  return lines.length > 0 && lines.every((line) => line.includes(PANE_OWNER_UNVERIFIED_MARKER))
}

/** Owner errors a reattach can recover from: the saved session is kept, and Retry asks again. */
export function isPaneOwnerRecoveryError(error: string): boolean {
  const lines = error.split('\n').filter((line) => line.length > 0)
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        line.includes(PANE_OWNER_UNVERIFIED_MARKER) || line.includes(PANE_OWNER_CHANGED_MARKER)
    )
  )
}

/** Marks a fresh start's refusal so its banner does not claim a running terminal. */
export function markTerminalHistoryUnavailableBeforeStart(error: string): string {
  return error.replace(
    /terminal_history_unavailable(?!_before_start)/g,
    () => TERMINAL_HISTORY_BEFORE_START_MARKER
  )
}

export function isTerminalHistoryUnavailableError(error: string): boolean {
  const lines = error.split('\n').filter((line) => line.length > 0)
  return (
    lines.length > 0 && lines.every((line) => line.includes(TERMINAL_HISTORY_UNAVAILABLE_MARKER))
  )
}

/** Reattach failures that kept the saved session, where Retry asks the same terminal again. */
export function isReattachRetryError(error: string): boolean {
  return isPaneOwnerRecoveryError(error) || isTerminalHistoryUnavailableError(error)
}

function humanizeUnreattachableSession(error: string, t: Translate = translate): string {
  const explanation = t(
    'auto.components.terminal.pane.TerminalErrorToast.sessionUnavailable',
    "Orca couldn't reattach to this pane's terminal session on the host. Open a new terminal to continue."
  )
  // Why a replacer: a translation containing `$&` or `$1` would otherwise be read as a substitution.
  return UNREATTACHABLE_SESSIONS.reduce(
    (message, pattern) => message.replace(pattern.replaceAll, () => explanation),
    error
  )
}

export function isFolderWorkspacePathOnlyError(error: string): boolean {
  const lines = stripClientEnvironmentFooter(error)
    .split('\n')
    .filter((line) => line.trim().length > 0)
  return lines.length > 0 && lines.every(isFolderWorkspacePathError)
}

/** Swaps raw daemon-boundary codes for copy a user can act on. */
export function humanizeTerminalError(
  error: string,
  agentId?: string | null,
  t: Translate = translate
): string {
  if (isSshSignInRequiredTerminalError(error)) {
    return describeSshSignInRequiredTerminalError(error, t)
  }
  // Hosts send a held start as its code (older) or English sentence (newer); either reads in the user's language.
  const unwrapped = localizeWslDistroHoldText(unwrapHostRefusalIpcLines(error, t), t)
  let humanized = humanizeFolderWorkspacePathErrors(
    localizeTerminalSpawnHints(agentLaunchErrorText(unwrapped, agentId, t) ?? unwrapped, t)
  )
  if (humanized.includes(PANE_OWNER_UNVERIFIED_MARKER)) {
    const explanation = isPaneOwnerUnverifiedError(humanized)
      ? t(
          'auto.components.terminal.pane.TerminalErrorToast.42b283ecfc',
          "Orca couldn't safely reconnect this terminal because the host couldn't verify its saved session. Orca left the saved session unchanged. Click Retry to try reconnecting now. If it still cannot reconnect, open a new terminal."
        )
      : t(
          'auto.components.terminal.pane.TerminalErrorToast.ownerUnknown',
          "Orca couldn't verify this terminal's owner."
        )
    humanized = humanized.replaceAll(PANE_OWNER_UNVERIFIED_MARKER, () => explanation)
  }
  humanized = humanized.replaceAll(TERMINAL_HISTORY_BEFORE_START_MARKER, () =>
    t(
      'auto.components.terminal.pane.TerminalErrorToast.historyUnavailableBeforeStart',
      "Orca couldn't prepare this terminal's history on its host, so the terminal didn't start. Click Retry to try again."
    )
  )
  humanized = humanized.replaceAll(TERMINAL_HISTORY_UNAVAILABLE_MARKER, () =>
    t(
      'auto.components.terminal.pane.TerminalErrorToast.historyUnavailable',
      "Orca couldn't load this terminal's history from its host. Click Retry to reconnect it."
    )
  )
  humanized = humanized.replaceAll(PANE_OWNER_CHANGED_MARKER, () =>
    t(
      'auto.components.terminal.pane.TerminalErrorToast.ownerUnknown',
      "Orca couldn't verify this terminal's owner."
    )
  )
  humanized = humanized.replace(SOURCE_RESTORE_REQUIRED.replaceAll, () =>
    t(
      'auto.components.terminal.pane.TerminalErrorToast.sourceRestoring',
      'Reconnecting this terminal — its output is being re-established. The session is still running.'
    )
  )
  humanized = humanized.replace(OWNER_HOST_MISMATCH.replaceAll, () =>
    t(
      'auto.components.terminal.pane.TerminalErrorToast.ownerHostMismatch',
      "This terminal's saved session belongs to another host connection, so Orca can't reattach it here. Open a new terminal to continue."
    )
  )
  if (humanized.includes(REMOTE_TERMINAL_CLOSED_MARKER)) {
    humanized = humanized.replaceAll(REMOTE_TERMINAL_CLOSED_MARKER, () =>
      t(
        'auto.components.terminal.pane.TerminalErrorToast.remoteTerminalClosed',
        'Remote terminal was closed.'
      )
    )
  }
  humanized = humanizeUnreattachableSession(humanized, t)
  if (!isExplainedTerminalError(humanized)) {
    return humanized
  }
  const explanation = t(
    'auto.components.terminal.pane.TerminalErrorToast.e16012e31e',
    'The terminal daemon that owned this session exited, so the session and its scrollback could not be recovered. Open a new terminal to continue.'
  )
  return humanized
    .split('\n')
    .map((line) =>
      line
        .replace(TERMINAL_HOST_GONE.replaceAll, (_match, prefix: string) =>
          prefix.concat(explanation)
        )
        .replace(LEGACY_TERMINAL_HOST_GONE_PATTERN, (_match, prefix: string) =>
          prefix.concat(explanation)
        )
    )
    .join('\n')
}
