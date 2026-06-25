import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { StepState } from '../settings/BrowserUseStepBadge'

export function getMobileEmulatorCliPathNeedsAttention(status: CliInstallStatus | null): boolean {
  return status?.state === 'installed' && !status.pathConfigured
}

export function getMobileEmulatorCliStepBadgeState(input: {
  cliBusy: boolean
  cliEnabled: boolean
  cliPathNeedsAttention: boolean
}): StepState {
  if (input.cliEnabled) {
    return 'done'
  }
  if (input.cliBusy || input.cliPathNeedsAttention) {
    return 'in-progress'
  }
  return 'pending'
}

export function shouldShowMobileEmulatorSkillPreInstallNotice(input: {
  cliEnabled: boolean
  cliSkillInstalled: boolean
}): boolean {
  // Why: an installed skill should not reopen with "Install" just because CLI
  // probes are stale; only gate first-time setup on CLI availability.
  return !input.cliSkillInstalled && !input.cliEnabled
}
