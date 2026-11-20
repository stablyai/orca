import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { AntigravityChatAuthConfig } from '../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { SelectItem } from '../ui/select'

const GOOGLE_METHODS: readonly AntigravityChatAuthConfig['method'][] = ['oauth-personal']
const ALL_METHODS: readonly AntigravityChatAuthConfig['method'][] = [
  ...GOOGLE_METHODS,
  'gemini-api-key',
  'agent-platform'
]

export function antigravityChatAuthMethodLabel(
  method: string,
  t: Translate = translate
): string | null {
  switch (method) {
    case 'oauth-personal':
    case 'oauth-business':
      return t('accounts.antigravity.agySignIn', "agy's Google sign-in")
    case 'gemini-api-key':
      return t('accounts.antigravity.apiKey', 'Gemini API key')
    case 'agent-platform':
      return t('accounts.antigravity.agentPlatform', 'Google Agent Platform')
    default:
      return null
  }
}

function methodDescription(method: AntigravityChatAuthConfig['method'], t: Translate): string {
  switch (method) {
    case 'oauth-personal':
    case 'oauth-business':
      return t(
        'accounts.antigravity.agySignInOption',
        'Google or Gemini Enterprise, signed in in agy'
      )
    case 'gemini-api-key':
      return t('accounts.antigravity.apiKeyOption', 'A key from Google AI Studio')
    case 'agent-platform':
      return t('accounts.antigravity.agentPlatformOption', 'Your gcloud login (ADC)')
  }
}

/** The ways the host's Antigravity chat can sign in; older hosts offer only Google's. */
export function AntigravityChatAuthMethodItems({
  keyAndAdc
}: {
  keyAndAdc: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {(keyAndAdc ? ALL_METHODS : GOOGLE_METHODS).map((method) => (
        <SelectItem key={method} value={method} description={methodDescription(method, t)}>
          {antigravityChatAuthMethodLabel(method, t)}
        </SelectItem>
      ))}
    </>
  )
}
