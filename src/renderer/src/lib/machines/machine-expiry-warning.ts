import { translate } from '@/i18n/i18n'
import {
  formatMachineWorkAtRisk,
  MACHINE_EXPIRY_WARNING_MS,
  machineLocalExpiresAt,
  type MachineExpiryWarning
} from '../../../../shared/machine-inventory'
import type { MachineMatch } from './machine-host-match'

const clockTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** Local expiry inside the warning window, or null when there is nothing to warn about yet. */
export function getWarnableExpiry(match: MachineMatch, now: number): number | null {
  if (match.machine.lifetime !== 'temporary' || match.machine.state === 'gone') {
    return null
  }
  const expiry = machineLocalExpiresAt(match.machine, match.snapshot.clockOffsetMs)
  return expiry !== null && expiry > now && expiry - now <= MACHINE_EXPIRY_WARNING_MS
    ? expiry
    : null
}

/**
 * "Deletes 4:12 PM · 3 unpushed commits" from main's warning, while the machine is still in its
 * last 15 minutes and the work is at risk or couldn't be read.
 */
export function getMachineExpiryWarning(
  match: MachineMatch,
  warning: MachineExpiryWarning | undefined,
  now: number
): string | null {
  // Why: a provider that extended the expiry leaves the old warning behind.
  if (!warning || getWarnableExpiry(match, now) === null) {
    return null
  }
  const work = warning.workAtRisk
  const atRisk = work === null ? null : formatMachineWorkAtRisk(work, translate)
  if (work !== null && atRisk === null) {
    return null
  }
  return translate(
    'auto.lib.machines.machineExpiryWarning.warningAt',
    'Deletes {{time}} · {{work}}',
    {
      time: clockTime.format(warning.expiresAt),
      work:
        work === null
          ? translate(
              'auto.lib.machines.machineExpiryWarning.unknown',
              'Couldn’t check unsaved work'
            )
          : atRisk
    }
  )
}
