import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'
import {
  resolveSupportedHostedReviewCopyProvider,
  type LocalizedHostedReviewCopy,
  type SupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'

// Commands and variable names stay untranslated.
const SIGN_IN_COMMANDS = { github: 'gh auth login', gitlab: 'glab auth login' } as const
const SIGN_IN_VARIABLES = {
  'azure-devops': 'ORCA_AZURE_DEVOPS_TOKEN',
  gitea: 'ORCA_GITEA_TOKEN'
} as const

export function authRequiredDetail(
  provider: SupportedHostedReviewCopyProvider,
  copy: LocalizedHostedReviewCopy
): string {
  if (provider === 'bitbucket') {
    return translate(
      'sourceControl.createReviewFailure.authRequiredBitbucket',
      'Bitbucket is not authenticated. Next step: connect Bitbucket in Settings > Integrations, or set ORCA_BITBUCKET_* in this environment.'
    )
  }
  // Azure DevOps accepts either an az CLI sign-in or the token variable.
  if (provider === 'azure-devops') {
    return translate(
      'sourceControl.createReviewFailure.authRequiredAzureDevOps',
      '{{providerName}} is not authenticated. Next step: run az login, or set {{variable}} in this environment.',
      { providerName: copy.providerName, variable: SIGN_IN_VARIABLES['azure-devops'] }
    )
  }
  if (provider === 'github' || provider === 'gitlab') {
    return translate(
      'sourceControl.createReviewFailure.authRequiredCommand',
      '{{providerName}} is not authenticated. Next step: run {{command}} in this environment.',
      { providerName: copy.providerName, command: SIGN_IN_COMMANDS[provider] }
    )
  }
  return translate(
    'sourceControl.createReviewFailure.authRequiredVariable',
    '{{providerName}} is not authenticated. Next step: set {{variable}} in this environment.',
    { providerName: copy.providerName, variable: SIGN_IN_VARIABLES[provider] }
  )
}

/** Short sign-in step for space-constrained surfaces like the Create PR dropdown hint. */
export function hostedReviewSignInHint(provider: HostedReviewProvider | undefined): string {
  const supported = resolveSupportedHostedReviewCopyProvider(provider)
  if (supported === 'bitbucket') {
    return translate(
      'sourceControl.createReviewFailure.signInHintBitbucket',
      'Connect Bitbucket in Settings > Integrations'
    )
  }
  if (supported === 'azure-devops') {
    return translate(
      'sourceControl.createReviewFailure.signInHintAzureDevOps',
      'Run az login or set {{variable}} in this environment',
      { variable: SIGN_IN_VARIABLES['azure-devops'] }
    )
  }
  if (supported === 'github' || supported === 'gitlab') {
    return translate(
      'sourceControl.createReviewFailure.signInHintCommand',
      'Run {{command}} in this environment',
      { command: SIGN_IN_COMMANDS[supported] }
    )
  }
  return translate(
    'sourceControl.createReviewFailure.signInHintVariable',
    'Set {{variable}} in this environment',
    { variable: SIGN_IN_VARIABLES[supported] }
  )
}
