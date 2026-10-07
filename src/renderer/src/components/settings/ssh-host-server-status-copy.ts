/** User-facing words for which server an SSH host runs; every string goes through the catalog. */
import type {
  SSH_MANAGED_SERVER_PHASES,
  SshConnectionState,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

export type SshHostServerStatusLine = {
  text: string
  tone: 'muted' | 'warning' | 'destructive'
  /** Offers "Move to managed server", which restarts the live relay terminals. */
  action?: 'move'
  /** Main's untranslated cause, with the host's orcad.log tail when there is one; shown on request. */
  detail?: string
}

export function sshHostServerStatusLine(
  target: Pick<SshTarget, 'orcadFence' | 'managedServerUnavailable'>,
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
        'The managed Orca server isn’t running and couldn’t be started.'
      ),
      detail: status.serving.detail
    }
  }
  if (status?.kind === 'managed' && status.update) {
    return managedUpdateLine(status.update)
  }
  // A healthy managed server is the default; the card stays quiet unless something needs attention.
  if (status?.kind === 'managed' || (!status && target.orcadFence)) {
    return null
  }
  if (status?.kind === 'setting-up') {
    return { tone: 'muted', text: settingUpLabel(status.phase) }
  }
  if (status?.kind === 'relay') {
    return relayLine(status)
  }
  if (target.managedServerUnavailable) {
    return unavailableLine(target.managedServerUnavailable.reason)
  }
  return null
}

// Mirror main's ORCAD_TUNNEL_UNAVAILABLE_REASON.
const TUNNEL_UNAVAILABLE = 'ssh_tunnel_unavailable'

function sourceChangedLine(): SshHostServerStatusLine {
  return {
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.sourceChanged',
      'Changed on an older Orca: runs the relay until it is moved to its managed server again.'
    )
  }
}

/** `reason` is main's OrcadHostUnavailableReason; an unknown one is shown only as a detail. */
function unavailableLine(reason: string | undefined): SshHostServerStatusLine {
  if (reason === TUNNEL_UNAVAILABLE) {
    return tunnelUnavailableLine()
  }
  const cause = reason ? unavailableCause(reason) : null
  if (cause) {
    return {
      tone: 'muted',
      text: translate(
        'auto.components.settings.sshHostServer.unavailable',
        'Runs the relay: a managed Orca server can’t run on this host ({{reason}}).',
        { reason: cause }
      )
    }
  }
  return {
    tone: 'muted',
    text: translate(
      'auto.components.settings.sshHostServer.unavailableUnknown',
      'Runs the relay: a managed Orca server can’t run on this host.'
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
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.tunnelUnavailable',
      'Runs the relay: this host’s SSH server doesn’t allow port forwarding, and Orca couldn’t reach a managed server through the SSH session either.'
    )
  }
}

function retryLine(): SshHostServerStatusLine {
  return {
    tone: 'muted',
    text: translate(
      'auto.components.settings.sshHostServer.retry',
      'Runs the relay this session; it moves to a managed server on a later connect.'
    )
  }
}

function managedUpdateLine(update: SshManagedServerUpdateNote): SshHostServerStatusLine {
  switch (update.state) {
    case 'host-newer':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.hostNewer',
          'Runs a managed Orca server from a newer Orca; it keeps that version.'
        )
      }
    case 'deferred':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.updateDeferredLater',
          'Runs a managed Orca server; it updates on a later connect.'
        ),
        ...withDetail(update.detail)
      }
    case 'failed':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.updateFailedPrevious',
          'Runs a managed Orca server on its previous version; updating it failed.'
        ),
        ...withDetail(update.detail)
      }
  }
}

function settingUpLabel(phase: (typeof SSH_MANAGED_SERVER_PHASES)[number]): string {
  switch (phase) {
    case 'deploying':
      return translate(
        'auto.components.settings.sshHostServer.deploying',
        'Setting up a managed Orca server…'
      )
    case 'converting':
      return translate(
        'auto.components.settings.sshHostServer.converting',
        'Moving this host’s projects to its managed Orca server…'
      )
    case 'connecting':
      return translate(
        'auto.components.settings.sshHostServer.connecting',
        'Connecting to the managed Orca server…'
      )
    case 'updating':
      return translate(
        'auto.components.settings.sshHostServer.updating',
        'Updating managed server…'
      )
    case 'starting':
      return translate(
        'auto.components.settings.sshHostServer.starting',
        'Starting managed server…'
      )
  }
}

function relayLine(
  status: Extract<NonNullable<SshConnectionState['managedServer']>, { kind: 'relay' }>
): SshHostServerStatusLine {
  switch (status.reason) {
    case 'relay_terminals_live':
      if (status.terminalsElsewhere) {
        return { tone: 'muted', text: terminalsElsewhereText(status.terminals) }
      }
      return {
        tone: 'muted',
        // Why: an absent count is unreported, never zero open terminals.
        text: status.terminals
          ? translate(
              'auto.components.settings.sshHostServer.terminalsLive',
              'Runs the relay until its {{count}} open terminals are closed, then moves to a managed server.',
              { count: status.terminals }
            )
          : translate(
              'auto.components.settings.sshHostServer.terminalsLiveUncounted',
              'Runs the relay until its open terminals are closed, then moves to a managed server.'
            ),
        action: 'move'
      }
    case 'relay_terminals_unverifiable':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.terminalsUnverifiable',
          'Runs the relay: Orca couldn’t confirm its terminals are closed. It moves on a later connect.'
        )
      }
    case 'orcad_unavailable':
      return unavailableLine(status.detail)
    case 'source_changed':
      return sourceChangedLine()
    case 'refused':
      // `detail` is main's English refusal, so it stays behind "Details".
      return {
        tone: 'destructive',
        text: translate(
          'auto.components.settings.sshHostServer.refusedBlocked',
          'Not moved to a managed server: something on this host stops the move.'
        ),
        ...withDetail(status.detail)
      }
    case 'deferred':
    case 'failed':
      return { ...retryLine(), ...withDetail(status.detail) }
  }
}

function withDetail(detail: string | undefined): Pick<SshHostServerStatusLine, 'detail'> {
  return detail ? { detail } : {}
}

/** No move action: stopping this desktop's terminals can't end another desktop's. */
function terminalsElsewhereText(terminals: number | undefined): string {
  return terminals
    ? translate(
        'auto.components.settings.sshHostServer.terminalsElsewhere',
        'Runs the relay while {{count}} terminals another Orca desktop or session opened on this host are running.',
        { count: terminals }
      )
    : translate(
        'auto.components.settings.sshHostServer.terminalsElsewhereUncounted',
        'Runs the relay while terminals another Orca desktop or session opened on this host are running.'
      )
}
