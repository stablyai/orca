// Setup-session codes in words, for the Orca Cloud setup page.
import type { Translate } from '@/i18n/use-translate'
import type { CloudSetupStep } from './cloud-start-model'

/**
 * A setup session's rows name how a step is covered with a code ('subscription', 'trial',
 * 'checkout', 'requested'); say it in words, or nothing. Undefined: not a session code.
 */
export function sessionDetailCopy(step: CloudSetupStep, t: Translate): string | null | undefined {
  if (step.id === 'plan' && step.detail === 'subscription') {
    // "Team plan · Done" already says it.
    return null
  }
  if (step.id === 'plan' && step.detail === 'trial') {
    return t('components.newWorkspace.cloudSetup.planCoveredByTrial', 'Your trial covers it.')
  }
  if (step.id === 'plan' && step.detail === 'checkout') {
    return t(
      'components.newWorkspace.cloudSetup.planCheckoutOpen',
      'Finish checkout in your browser.'
    )
  }
  if (step.id === 'github' && step.detail === 'requested') {
    return t(
      'components.newWorkspace.cloudSetup.githubRequestedSession',
      'Waiting for an owner on GitHub to approve Orca Cloud.'
    )
  }
  return undefined
}
