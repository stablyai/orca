import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  AntigravityAuthFailureReason,
  AntigravityChatAuthAlternative
} from './antigravity-chat-auth-choices'

/** Which agy runs a chat and its version, so its models and account are no surprise. */
export function antigravityProgramLabel(
  orcas: boolean,
  version: string | null | undefined,
  t: Translate = translate
): string {
  if (orcas) {
    return version
      ? t('components.native-chat.antigravityAuth.orcasAgyVersion', "Orca's agy · v{{version}}", {
          version
        })
      : t('components.native-chat.antigravityAuth.orcasAgy', "Orca's agy")
  }
  return version
    ? t('components.native-chat.antigravityAuth.yourAgyVersion', 'Your agy · v{{version}}', {
        version
      })
    : t('components.native-chat.antigravityAuth.yourAgy', 'Your agy')
}

export function antigravityAlternativeLabel(
  option: AntigravityChatAuthAlternative,
  t: Translate = translate
): string {
  switch (option.method) {
    case 'gemini-api-key':
      return t('components.native-chat.antigravityAuth.useApiKey', 'Use your Gemini API key')
    case 'agent-platform':
      return t('components.native-chat.antigravityAuth.useGcloud', 'Use gcloud ({{project}})', {
        project: option.project
      })
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
        ? t(
            'components.native-chat.antigravityAuth.apiKeyFromEnvironment',
            'Found GEMINI_API_KEY in your environment'
          )
        : t('components.native-chat.antigravityAuth.apiKeySaved', 'Saved in Orca')
    case 'agent-platform':
      return t(
        'components.native-chat.antigravityAuth.gcloudFound',
        'Found your gcloud login (Application Default Credentials)'
      )
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
