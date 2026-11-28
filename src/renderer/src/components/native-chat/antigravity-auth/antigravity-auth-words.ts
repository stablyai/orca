import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  AntigravityAuthFailureReason,
  AntigravityChatAuthAlternative
} from './antigravity-chat-auth-choices'

/** The agy version a chat runs, so its models and account are no surprise; null until the host
 *  reports one. */
export function antigravityProgramLabel(
  version: string | null | undefined,
  t: Translate = translate
): string | null {
  return version
    ? t('components.native-chat.antigravityAuth.yourAgyVersion', 'Your agy · v{{version}}', {
        version
      })
    : null
}

export function antigravityAlternativeLabel(
  option: AntigravityChatAuthAlternative,
  t: Translate = translate
): string {
  switch (option.method) {
    case 'gemini-api-key':
      return t('components.native-chat.antigravityAuth.useApiKey', 'Use your Gemini API key')
    case 'agent-platform':
      return t('components.native-chat.antigravityAuth.useGcloudLogin', 'Use your gcloud login')
    case 'oauth-personal':
      return t('components.native-chat.antigravityAuth.useGoogle', 'Use your Google sign-in')
  }
}

/** Where Orca found the credentials, so the person knows which ones it will use. */
export function antigravityAlternativeHint(
  option: AntigravityChatAuthAlternative,
  t: Translate = translate
): string {
  switch (option.method) {
    case 'gemini-api-key':
      return option.source === 'environment'
        ? t('components.native-chat.antigravityAuth.apiKeyEnvironment', 'From your environment')
        : t('components.native-chat.antigravityAuth.apiKeySaved', 'Saved in Orca')
    case 'agent-platform':
      return t('components.native-chat.antigravityAuth.gcloudProject', 'Project {{project}}', {
        project: option.project
      })
    case 'oauth-personal':
      return t(
        'components.native-chat.antigravityAuth.googleFound',
        'You signed in with Google on this host before'
      )
  }
}

/** The question a failure notice ends with, naming what Orca found. */
export function antigravityAlternativeQuestion(
  option: AntigravityChatAuthAlternative,
  t: Translate = translate
): string {
  switch (option.method) {
    case 'gemini-api-key':
      return option.source === 'environment'
        ? t(
            'components.native-chat.antigravityAuth.askApiKeyEnvironment',
            'Use the Gemini API key found in your environment instead?'
          )
        : t(
            'components.native-chat.antigravityAuth.askApiKeySaved',
            'Use the Gemini API key saved in Orca instead?'
          )
    case 'agent-platform':
      return t(
        'components.native-chat.antigravityAuth.askGcloud',
        'Use your gcloud login (project {{project}}) instead?',
        { project: option.project }
      )
    case 'oauth-personal':
      return t(
        'components.native-chat.antigravityAuth.askGoogle',
        'Use your Google sign-in instead?'
      )
  }
}

/** The plain cause, said once, before the offer. */
export function antigravityAuthFailureLead(
  reason: AntigravityAuthFailureReason,
  t: Translate = translate
): string {
  switch (reason) {
    case 'noSubscription':
      return t(
        'components.native-chat.antigravityAuth.noSubscription',
        'This Google account has no Antigravity subscription.'
      )
    case 'ineligible':
      return t(
        'components.native-chat.antigravityAuth.ineligible',
        "This Google account can't use Antigravity."
      )
    case 'signedOut':
      return t('components.native-chat.antigravityAuth.signedOut', "Antigravity isn't signed in.")
    case 'refused':
      return t(
        'components.native-chat.antigravityAuth.refused',
        "Google refused this chat's credentials."
      )
    case 'usageLimit':
      return t(
        'components.native-chat.antigravityAuth.usageLimit',
        'This sign-in reached its usage limit.'
      )
  }
}

/** The one line under the strip's title naming what else Orca found; null when nothing. */
export function antigravityFoundLine(
  alternatives: readonly AntigravityChatAuthAlternative[],
  t: Translate = translate
): string | null {
  const key = alternatives.some((option) => option.method === 'gemini-api-key')
  const gcloud = alternatives.some((option) => option.method === 'agent-platform')
  if (key && gcloud) {
    return t(
      'components.native-chat.antigravityAuth.foundKeyAndGcloud',
      'Your Gemini API key and gcloud login also work.'
    )
  }
  if (key) {
    return t('components.native-chat.antigravityAuth.foundKey', 'Your Gemini API key also works.')
  }
  return gcloud
    ? t('components.native-chat.antigravityAuth.foundGcloud', 'Your gcloud login also works.')
    : null
}
