import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'
import {
  resolveSupportedHostedReviewCopyProvider,
  type LocalizedHostedReviewCopy,
  type SupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'

// Commands and variable names stay untranslated.
const SIGN_IN_COMMANDS = {
  github: 'gh auth login',
  gitlab: 'glab auth login'
} as const
const SIGN_IN_VARIABLES = {
  'azure-devops': 'ORCA_AZURE_DEVOPS_TOKEN'
} as const
const GITEA_SIGN_IN_COMMAND = 'tea login add'
const GITEA_TOKEN_VARIABLE = 'ORCA_GITEA_TOKEN'

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
  if (provider === 'github' || provider === 'gitlab') {
    return translate(
      'sourceControl.createReviewFailure.authRequiredCommand',
      '{{providerName}} is not authenticated. Next step: run {{command}} in this environment.',
      { providerName: copy.providerName, command: SIGN_IN_COMMANDS[provider] }
    )
  }
  if (provider === 'gitea') {
    return translate(
      'sourceControl.createReviewFailure.authRequiredGitea',
      '{{providerName}} is not authenticated. Next step: run {{command}} or set {{variable}} in this environment.',
      {
        providerName: copy.providerName,
        command: GITEA_SIGN_IN_COMMAND,
        variable: GITEA_TOKEN_VARIABLE
      }
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
  if (supported === 'github' || supported === 'gitlab') {
    return translate(
      'sourceControl.createReviewFailure.signInHintCommand',
      'Run {{command}} in this environment',
      { command: SIGN_IN_COMMANDS[supported] }
    )
  }
  if (supported === 'gitea') {
    return translate(
      'sourceControl.createReviewFailure.signInHintGitea',
      'Run {{command}} or set {{variable}} in this environment',
      { command: GITEA_SIGN_IN_COMMAND, variable: GITEA_TOKEN_VARIABLE }
    )
  }
  return translate(
    'sourceControl.createReviewFailure.signInHintVariable',
    'Set {{variable}} in this environment',
    { variable: SIGN_IN_VARIABLES[supported] }
  )
}
