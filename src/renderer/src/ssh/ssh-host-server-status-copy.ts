// Translate managed SSH server status through the catalog.
import type {
  SshConnectionState,
  SshManagedServerLinkedProject,
  SshTarget
} from '../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { compactIpcErrorMessage, extractIpcErrorMessage } from '@/lib/ipc-error'
import { isWebClientLocation } from '@/lib/web-client-location'
import { launchSessionEndedLine } from './ssh-host-launch-session-copy'
import { automationsLeftDisabledLine } from './ssh-host-moved-automations-copy'
import { bridgedTerminalsLine } from './ssh-host-bridged-terminals-copy'
import { managedUpdateLine, withDetail } from './ssh-host-server-update-copy'
import { blockedNodeDownload, nodeDownloadBlockedText } from './ssh-host-node-download-copy'
import { settingUpLabel, sshHostServerReassurance } from './ssh-host-server-setup-copy'
import { hostFixableUnavailableText } from './ssh-host-fixable-unavailable-copy'
import { leaveBehindLine, REFUSAL_INLINE_CHARS, refusedLine } from './ssh-host-refused-move-copy'

export type SshHostServerStatusLine = {
  text: string
  tone: 'muted' | 'warning' | 'destructive'
  /** Main's untranslated cause, with the host's orcad.log tail when there is one; shown on request. */
  detail?: string
  /** A muted second line, e.g. what moving onto the host does and doesn't touch. */
  hint?: string
}

export function sshHostServerStatusLine(
  target: Pick<SshTarget, 'label' | 'orcadFence' | 'managedServerUnavailable'>,
  state: Pick<SshConnectionState, 'managedServer'> | undefined
): SshHostServerStatusLine | null {
  const status = state?.managedServer
  if (target.orcadFence?.sourceChangedAt) {
    return sourceChangedLine()
  }
  if (status?.kind === 'managed' && status.serving) {
    return {
      tone: 'warning',
      text: translate(
        'auto.components.settings.sshHostServer.notServing',
        'Orca couldn’t confirm that its server on {{host}} is answering.',
        { host: target.label }
      ),
      detail: status.serving.detail
    }
  }
  if (status?.kind === 'managed' && status.launchSessionEnded) {
    return launchSessionEndedLine()
  }
  if (status?.kind === 'managed' && status.update) {
    return managedUpdateLine(status.update)
  }
  if (status?.kind === 'managed' && status.linked?.length) {
    return linkedProjectsLine(status.linked)
  }
  if (status?.kind === 'managed' && status.automationsLeftDisabled) {
    return automationsLeftDisabledLine(status.automationsLeftDisabled)
  }
  // A healthy managed server is the default; the card stays quiet unless something needs attention.
  if (status?.kind === 'managed' || (!status && target.orcadFence)) {
    return null
  }
  if (status?.kind === 'setting-up') {
    return {
      tone: 'muted',
      text: settingUpLabel(status.phase, target.label),
      // Why only these phases: `starting` and `connecting` run on every reconnect, when nothing moves.
      ...(status.phase === 'deploying' || status.phase === 'converting'
        ? { hint: sshHostServerReassurance(target.label) }
        : {})
    }
  }
  if (status?.kind === 'relay') {
    // An unverifiable bridged terminal keeps the unverifiable line: nothing proves it still answers.
    return status.bridged && status.reason === 'relay_terminals_live'
      ? bridgedTerminalsLine(status.detail)
      : unservedLine(status)
  }
  if (target.managedServerUnavailable) {
    return unavailableLine(target.managedServerUnavailable.reason)
  }
  return null
}

export function sshConnectFailureText(
  state: Pick<SshConnectionState, 'managedServer'> | undefined,
  fallback: string
): string {
  const status = state?.managedServer
  // Uncapped because panes/toasts lack Details and refusal recovery guidance comes last.
  return status?.kind === 'relay' ? unservedLine(status, Number.POSITIVE_INFINITY).text : fallback
}

export function sshTargetConnectFailureText(
  targetId: string,
  error: unknown,
  fallback: string
): string {
  const state = useAppStore.getState().sshConnectionStates.get(targetId)
  // Main publishes the failure with its next step; the rejection carries only SSH's raw words.
  const published =
    state?.status === 'error' || state?.status === 'auth-failed'
      ? compactIpcErrorMessage(state.error ?? '')
      : undefined
  return sshConnectFailureText(state, published || extractIpcErrorMessage(error, fallback))
}

// Mirror main's ORCAD_TUNNEL_UNAVAILABLE_REASON.
const TUNNEL_UNAVAILABLE = 'ssh_tunnel_unavailable'

function sourceChangedLine(): SshHostServerStatusLine {
  return {
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.sourceChanged',
      'This computer has projects or folders for this host that its Orca server doesn’t have yet, often added by an older version of Orca. Move them to this host’s Orca server, or keep the server’s version, to connect again.'
    )
  }
}

/** `reason` is main's OrcadHostUnavailableReason; an unknown one is shown only as a detail. */
function unavailableLine(reason: string | undefined): SshHostServerStatusLine {
  if (reason === TUNNEL_UNAVAILABLE) {
    return tunnelUnavailableLine()
  }
  const fixable = reason ? hostFixableUnavailableText(reason) : null
  if (fixable) {
    return { tone: 'destructive', text: fixable }
  }
  const cause = reason ? unavailableCause(reason) : null
  if (cause) {
    return {
      tone: 'destructive',
      text: translate(
        'auto.components.settings.sshHostServer.unsupported',
        'This host isn’t supported by this version of Orca ({{reason}}). To keep using it, install an older version of Orca.',
        { reason: cause }
      )
    }
  }
  return {
    tone: 'destructive',
    text: translate(
      'auto.components.settings.sshHostServer.unsupportedUnknown',
      'This host isn’t supported by this version of Orca. To keep using it, install an older version of Orca.'
    ),
    ...(reason ? { detail: reason } : {})
  }
}

function unavailableCause(reason: string): string | null {
  switch (reason) {
    case 'unsupported_host':
      return translate(
        'auto.components.settings.sshHostServer.cause.unsupportedHost',
        'Orca has no server build for this system'
      )
    case 'artifacts_unavailable':
      return translate(
        'auto.components.settings.sshHostServer.cause.artifactsUnavailable',
        'this Orca build doesn’t include the server'
      )
    case 'libc_unidentified':
      return translate(
        'auto.components.settings.sshHostServer.cause.libcUnidentified',
        'Orca couldn’t identify the host’s system libraries'
      )
    case 'runtime_self_test':
      return translate(
        'auto.components.settings.sshHostServer.cause.runtimeSelfTest',
        'the server’s runtime failed its self-test'
      )
    case 'security_software':
      return translate(
        'auto.components.settings.sshHostServer.cause.securitySoftware',
        'security software changed the server’s runtime'
      )
    case 'native_preflight':
      return translate(
        'auto.components.settings.sshHostServer.cause.nativePreflight',
        'the host is missing system libraries the server needs'
      )
    default:
      return null
  }
}

function tunnelUnavailableLine(): SshHostServerStatusLine {
  return {
    tone: 'destructive',
    text: translate(
      'auto.components.settings.sshHostServer.tunnelUnsupported',
      'This host isn’t supported by this version of Orca: its SSH server doesn’t allow port forwarding, and Orca couldn’t reach its server through the SSH session either. To keep using it, install an older version of Orca.'
    )
  }
}

function retryLine(): SshHostServerStatusLine {
  return {
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.setupRetry',
      'Orca couldn’t start its server on this host. Try connecting again.'
    )
  }
}

function contactLostLine(): SshHostServerStatusLine {
  return {
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.setupContactLost',
      'Orca lost contact with this host while setting up its server. Nothing on the host was stopped. Connect again to continue.'
    )
  }
}

function heldMoveLine(): SshHostServerStatusLine {
  return {
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.moveHeld',
      'Orca paused moving this host’s projects to its Orca server because it couldn’t confirm the server’s copy. Nothing is lost: the host keeps its projects and stays locked until the move finishes. Connect again to resume. If the server can’t come back, stop or forget it in Settings > Orca on your SSH hosts.'
    )
  }
}

/** Projects the server already had: this desktop's own tabs and automations for them stayed behind. */
function linkedProjectsLine(
  linked: readonly SshManagedServerLinkedProject[]
): SshHostServerStatusLine {
  const paths = linked.map((project) => project.path).join(', ')
  const count = linked.reduce((total, project) => total + project.automations, 0)
  return {
    tone: 'warning',
    text:
      count > 0
        ? translate(
            'auto.components.settings.sshHostServer.linkedProjects',
            'This host’s Orca server already had {{paths}}, so this desktop now uses the server’s copy. This desktop’s tabs and {{count}} automations there were not moved, and worktrees it created there show as external worktrees.',
            { paths, count }
          )
        : translate(
            'auto.components.settings.sshHostServer.linkedProjectsNoAutomations',
            'This host’s Orca server already had {{paths}}, so this desktop now uses the server’s copy. This desktop’s tabs there were not moved, and worktrees it created there show as external worktrees.',
            { paths }
          )
  }
}

function unservedLine(
  status: Extract<NonNullable<SshConnectionState['managedServer']>, { kind: 'relay' }>,
  refusalChars = REFUSAL_INLINE_CHARS
): SshHostServerStatusLine {
  switch (status.reason) {
    case 'relay_terminals_live':
      return {
        tone: 'warning',
        // Why: an absent count is unreported, never zero open terminals.
        text: status.terminals
          ? translate(
              'auto.components.settings.sshHostServer.olderTerminals',
              '{{count}} terminals started by an older version of Orca are still running on this host, and they don’t stop on their own. Close them in that version of Orca or end them on the host, then reconnect.',
              { count: status.terminals }
            )
          : translate(
              'auto.components.settings.sshHostServer.olderTerminalsUncounted',
              'Terminals started by an older version of Orca are still running on this host, and they don’t stop on their own. Close them in that version of Orca or end them on the host, then reconnect.'
            )
      }
    case 'relay_terminals_unverifiable':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.olderTerminalsUnverifiable',
          'Orca couldn’t confirm that terminals started by an older version of Orca have exited. Reconnect to try again.'
        )
      }
    case 'orcad_unavailable':
      return unavailableLine(status.detail)
    case 'source_changed':
      return sourceChangedLine()
    case 'refused':
      // Web clients can't run this desktop's Move anyway, so they keep main's reason.
      return status.canLeaveBehind && !isWebClientLocation()
        ? leaveBehindLine(status.detail, refusalChars)
        : refusedLine(status.detail, refusalChars)
    case 'deferred':
    case 'failed': {
      const blocked = blockedNodeDownload(status)
      return {
        ...(blocked
          ? { tone: 'destructive' as const, text: nodeDownloadBlockedText(blocked) }
          : status.held
            ? heldMoveLine()
            : status.contactLost
              ? contactLostLine()
              : retryLine()),
        ...withDetail(status.detail)
      }
    }
  }
}
