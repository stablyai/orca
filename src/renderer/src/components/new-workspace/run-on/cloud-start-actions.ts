// The fix one click runs before a setup session exists (sign in first, else the plan/billing
// action); the setup page's fallback when the session can't open.
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import { getOrcaCloudPick, type OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import type { CloudSetupStep } from './cloud-start-model'

/** The fix one click on the primary button runs: sign in first, else the plan/billing action. */
export function setupActionFor(
  steps: readonly CloudSetupStep[],
  access: OrcaCloudRunTargetAccess,
  availability: OrcaCloudAvailability
): (() => void) | null {
  if (steps.some((step) => step.id === 'account' && step.state === 'needed')) {
    const pick = getOrcaCloudPick({ state: 'signed-out' })
    return pick.kind === 'act' ? pick.run : null
  }
  const effective: OrcaCloudRunTargetAccess =
    availability === 'needs-capability' && access.state !== 'no-plan'
      ? { state: 'no-plan', lapsed: false, canManageBilling: true }
      : access
  const pick = getOrcaCloudPick(effective)
  return pick.kind === 'act' ? pick.run : null
}
