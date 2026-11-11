// Which sandbox hours a start spends (O4): the start toast and the build sheet chip. Hours only,
// never dollars; during a trial they say so.
import type { Translate } from '@/i18n/use-translate'
import {
  getOrcaCloudHoursLeft,
  type OrcaCloudRunTargetAccess
} from '../orca-cloud-run-target-access'

function hoursArgs(remainingSeconds: number, locale: string) {
  const count = getOrcaCloudHoursLeft(remainingSeconds)
  return {
    count,
    hours: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(count)
  }
}

/** "Trial · 1.4 sandbox hours left" / "41 sandbox hours left"; null when not entitled. */
export function getOrcaCloudHoursChip(
  access: OrcaCloudRunTargetAccess,
  t: Translate,
  locale: string
): string | null {
  if (access.state !== 'entitled') {
    return null
  }
  const args = hoursArgs(access.remainingSeconds, locale)
  return access.trial
    ? t('components.newWorkspace.cloudHours.trialChip', 'Trial · {{hours}} sandbox hours left', {
        count: args.count,
        hours: args.hours,
        defaultValue_one: 'Trial · {{hours}} sandbox hour left'
      })
    : t('components.newWorkspace.cloudHours.planChip', '{{hours}} sandbox hours left', {
        count: args.count,
        hours: args.hours,
        defaultValue_one: '{{hours}} sandbox hour left'
      })
}

/** T1: under half an hour of trial left, the hint turns to a warning with the fix. */
export const ORCA_CLOUD_TRIAL_LOW_SECONDS = 30 * 60

export function isOrcaCloudTrialLow(access: OrcaCloudRunTargetAccess): boolean {
  return (
    access.state === 'entitled' &&
    access.trial === true &&
    access.remainingSeconds < ORCA_CLOUD_TRIAL_LOW_SECONDS
  )
}
