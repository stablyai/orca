// What the "Start in Orca Cloud" primary button says, and the fix one click runs before a session
// exists (sign in first, else the plan/billing action).
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import { getOrcaCloudPick, type OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import type { CloudPrimaryAction, CloudSetupStep } from './cloud-start-model'

export function getCloudPrimaryLabel(action: CloudPrimaryAction): string {
  switch (action) {
    case 'start':
    case 'startTrial':
      return translate('components.newWorkspace.cloudStart.start', 'Start in Orca Cloud')
    case 'setUpAndStart':
      return translate('components.newWorkspace.cloudStart.setUpAndStart', 'Set up and start')
    case 'choosePlanAndStart':
      return translate(
        'components.newWorkspace.cloudStart.choosePlanAndStart',
        'Choose plan and start'
      )
    case 'renewAndStart':
      return translate('components.newWorkspace.cloudStart.renewAndStart', 'Renew and start')
    case 'giveAccessAndStart':
      return translate(
        'components.newWorkspace.cloudStart.giveAccessAndStart',
        'Give access and start'
      )
    case 'useThisComputer':
      return translate(
        'components.newWorkspace.cloudStart.useThisComputer',
        'Use this computer instead'
      )
    case 'checking':
      return translate('components.newWorkspace.cloudStart.checking', 'Checking Orca Cloud…')
  }
}

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

/** D2: an owner approved on GitHub while this composer waits; offer the start (never auto). */
export function showGitHubGrantedToast(repoName: string, onStart: () => void): void {
  toast.message(
    translate(
      'components.newWorkspace.cloudStart.githubGranted',
      'GitHub access granted for {{repo}}',
      {
        repo: repoName
      }
    ),
    { action: { label: getCloudPrimaryLabel('start'), onClick: onStart } }
  )
}
