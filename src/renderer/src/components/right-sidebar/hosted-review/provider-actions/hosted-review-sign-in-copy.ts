import type { HostedReviewProvider } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
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
  copy: LocalizedHostedReviewCopy,
  t: Translate = translate
): string {
  if (provider === 'bitbucket') {
    return t(
      'sourceControl.createReviewFailure.authRequiredBitbucket',
      'Bitbucket is not authenticated. Next step: connect Bitbucket in Settings > Integrations, or set ORCA_BITBUCKET_* in this environment.'
    )
  }
  if (provider === 'github' || provider === 'gitlab') {
    return t(
      'sourceControl.createReviewFailure.authRequiredCommand',
      '{{providerName}} is not authenticated. Next step: run {{command}} in this environment.',
      { providerName: copy.providerName, command: SIGN_IN_COMMANDS[provider] }
    )
  }
  return t(
    'sourceControl.createReviewFailure.authRequiredVariable',
    '{{providerName}} is not authenticated. Next step: set {{variable}} in this environment.',
    { providerName: copy.providerName, variable: SIGN_IN_VARIABLES[provider] }
  )
}

/** Short sign-in step for space-constrained surfaces like the Create PR dropdown hint. */
export function hostedReviewSignInHint(
  provider: HostedReviewProvider | undefined,
  t: Translate = translate
): string {
  const supported = resolveSupportedHostedReviewCopyProvider(provider)
  if (supported === 'bitbucket') {
    return t(
      'sourceControl.createReviewFailure.signInHintBitbucket',
      'Connect Bitbucket in Settings > Integrations'
    )
  }
  if (supported === 'github' || supported === 'gitlab') {
    return t(
      'sourceControl.createReviewFailure.signInHintCommand',
      'Run {{command}} in this environment',
      { command: SIGN_IN_COMMANDS[supported] }
    )
  }
  return t(
    'sourceControl.createReviewFailure.signInHintVariable',
    'Set {{variable}} in this environment',
    { variable: SIGN_IN_VARIABLES[supported] }
  )
}
