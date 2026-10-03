/** User-facing words for which server an SSH host runs; every string goes through the catalog. */
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

export type SshHostServerStatusLine = { text: string; tone: 'muted' | 'warning' | 'destructive' }

export function sshHostServerStatusLine(
  target: Pick<SshTarget, 'orcadFence' | 'managedServerUnavailable'>,
  state: Pick<SshConnectionState, 'managedServer'> | undefined
): SshHostServerStatusLine | null {
  const status = state?.managedServer
  if (target.orcadFence?.sourceChangedAt) {
    return {
      tone: 'warning',
      text: translate(
        'auto.components.settings.sshHostServer.sourceChanged',
        'Changed on an older Orca: runs the relay until it is moved to its managed server again.'
      )
    }
  }
  if (status?.kind === 'managed' || (!status && target.orcadFence)) {
    return {
      tone: 'muted',
      text: translate(
        'auto.components.settings.sshHostServer.managed',
        'Runs a managed Orca server'
      )
    }
  }
  if (status?.kind === 'setting-up') {
    return { tone: 'muted', text: settingUpLabel(status.phase) }
  }
  if (status?.kind === 'relay') {
    return relayLine(status)
  }
  if (target.managedServerUnavailable) {
    return {
      tone: 'muted',
      text: translate(
        'auto.components.settings.sshHostServer.unavailable',
        'Runs the relay: a managed Orca server can’t run on this host ({{reason}}).',
        { reason: target.managedServerUnavailable.reason }
      )
    }
  }
  return null
}

function settingUpLabel(phase: 'deploying' | 'converting' | 'connecting'): string {
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
  }
}

function relayLine(
  status: Extract<NonNullable<SshConnectionState['managedServer']>, { kind: 'relay' }>
): SshHostServerStatusLine {
  switch (status.reason) {
    case 'relay_terminals_live':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.terminalsLive',
          'Runs the relay until its {{count}} open terminals are closed, then moves to a managed server.',
          { count: status.terminals ?? 0 }
        )
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
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.unavailable',
          'Runs the relay: a managed Orca server can’t run on this host ({{reason}}).',
          { reason: status.detail ?? '' }
        )
      }
    case 'source_changed':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.sourceChanged',
          'Changed on an older Orca: runs the relay until it is moved to its managed server again.'
        )
      }
    case 'refused':
      return {
        tone: 'destructive',
        text: translate(
          'auto.components.settings.sshHostServer.refused',
          'Not moved to a managed server: {{blocker}}',
          { blocker: status.detail ?? '' }
        )
      }
    case 'deferred':
    case 'failed':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.retry',
          'Runs the relay this session; it moves to a managed server on a later connect.'
        )
      }
  }
}
