import type {
  MachineLifetime,
  MachineProviderErrorCode
} from '../../../../shared/machine-provider-protocol'
import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { getDraftExpiry, type MachineCreateDraft } from './machine-create-draft'
import { getMachineDisplayState, getMachineDisplayStateLabel } from './machine-display-state'
import { machineLocalExpiresAt } from '../../../../shared/machine-inventory'
import type { MachineMatch } from './machine-host-match'

const clockTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** "Deletes 4:12 PM": the absolute local time, which a person can plan around. */
export function formatMachineExpiry(expiresAt: number): string {
  return translate('auto.lib.machines.machineCopy.deletesAt', 'Deletes {{time}}', {
    time: clockTime.format(expiresAt)
  })
}

/** "deletes 4:12 PM", for the middle of a "·"-joined line. */
export function formatMachineExpiryInline(expiresAt: number): string {
  return translate('auto.lib.machines.machineCopy.deletesAtLower', 'deletes {{time}}', {
    time: clockTime.format(expiresAt)
  })
}

export function getMachineLifetimeLabel(lifetime: MachineLifetime): string {
  return lifetime === 'temporary'
    ? translate('auto.lib.machines.machineCopy.temporary', 'Temporary')
    : translate('auto.lib.machines.machineCopy.persistent', 'Persistent')
}

/** The Run-on detail for a chosen machine: provider, then lifetime and expiry when temporary. */
export function formatMachineSummary(
  providerName: string,
  machine: { lifetime: MachineLifetime; expiresAt: number | null }
): string {
  if (machine.lifetime !== 'temporary') {
    return providerName
  }
  const parts = [providerName, getMachineLifetimeLabel(machine.lifetime)]
  if (machine.expiresAt !== null) {
    parts.push(formatMachineExpiryInline(machine.expiresAt))
  }
  return parts.join(' · ')
}

/** The Run-on detail for a machine about to be created: provider, lifetime, and when it goes. */
export function formatMachineDraftSummary(
  providerName: string,
  draft: MachineCreateDraft,
  now: number
): string {
  const expiry = getDraftExpiry(draft, now)
  const parts = [providerName, getMachineLifetimeLabel(draft.lifetime)]
  if (expiry !== null) {
    parts.push(formatMachineExpiryInline(expiry))
  }
  return parts.join(' · ')
}

export function formatProviderUnreachable(lastSeenAt: number | null, now: number): string {
  return lastSeenAt === null
    ? translate('auto.lib.machines.machineCopy.cantReach', 'Can’t reach')
    : translate('auto.lib.machines.machineCopy.cantReachSeen', 'Can’t reach · seen {{ago}} ago', {
        ago: formatShortTimeAgo(lastSeenAt, now)
      })
}

/** One plain sentence for a failed machine action; the provider's own words go to the log. */
export function describeMachineFailure(code: MachineProviderErrorCode): string {
  switch (code) {
    case 'auth-required':
    case 'context-mismatch':
      return translate(
        'auto.lib.machines.machineCopy.failureSignIn',
        'The provider needs you to sign in again.'
      )
    case 'not-found':
      return translate(
        'auto.lib.machines.machineCopy.failureNotFound',
        'The provider no longer has this machine.'
      )
    case 'quota':
      return translate(
        'auto.lib.machines.machineCopy.failureQuota',
        'The provider is out of room for more machines.'
      )
    case 'timeout':
      return translate(
        'auto.lib.machines.machineCopy.failureTimeout',
        'The provider didn’t answer in time.'
      )
    case 'unsupported':
      return translate(
        'auto.lib.machines.machineCopy.failureUnsupported',
        'The provider can’t do that for this machine.'
      )
    case 'cancelled':
      return translate('auto.lib.machines.machineCopy.failureCancelled', 'It was canceled.')
    case 'conflict':
    case 'unavailable':
    case 'invalid-response':
    case 'protocol-unsupported':
      return translate(
        'auto.lib.machines.machineCopy.failureUnavailable',
        'The provider ran into a problem.'
      )
  }
}

/** "omarchy-dev on Omarchy · Running · Temporary · deletes 4:12 PM", for tooltips. */
export function describeMachine(match: MachineMatch): string {
  const { machine, snapshot } = match
  const parts = [
    translate('auto.lib.machines.machineCopy.onProvider', '{{machine}} on {{provider}}', {
      machine: machine.name,
      provider: snapshot.name
    }),
    getMachineDisplayStateLabel(getMachineDisplayState(machine.state)),
    getMachineLifetimeLabel(machine.lifetime)
  ]
  const expiry = machineLocalExpiresAt(machine, snapshot.clockOffsetMs)
  if (machine.lifetime === 'temporary' && expiry !== null) {
    parts.push(formatMachineExpiryInline(expiry))
  }
  return parts.join(' · ')
}

/** A menu action's failure; `conflict` there means another action on the machine is still running. */
export function describeMachineActionFailure(code: MachineProviderErrorCode, name: string): string {
  return code === 'conflict'
    ? translate(
        'auto.lib.machines.machineCopy.actionConflict',
        'Another action is running on {{name}}.',
        { name }
      )
    : describeMachineFailure(code)
}

/** "ux-1 was deleted": why a sleeping, archived or deleted machine's worktree can't be reached. */
export function getStoppedMachineTitle(match: MachineMatch): string {
  const name = match.machine.name
  if (match.machine.state === 'gone') {
    return translate('auto.components.machines.StoppedMachineBanner.gone', '{{name}} was deleted', {
      name
    })
  }
  if (match.machine.state === 'stopping') {
    return translate(
      'auto.components.machines.StoppedMachineBanner.stopping',
      '{{name}} is going to sleep',
      { name }
    )
  }
  return match.machine.state === 'archived'
    ? translate('auto.components.machines.StoppedMachineBanner.archived', '{{name}} is archived', {
        name
      })
    : translate('auto.components.machines.StoppedMachineBanner.sleeping', '{{name}} is asleep', {
        name
      })
}

// The transport's own wording for a machine's server it can't reach; never shown raw.
const MACHINE_CONNECTION_ERROR =
  /runtimeEnvironments:call|port forward failed|Runtime environment is manually disconnected/i

export function isMachineConnectionError(error: string): boolean {
  return MACHINE_CONNECTION_ERROR.test(error)
}
