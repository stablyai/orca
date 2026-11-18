import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { AntigravityChatAuthConfig } from '../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { SelectItem } from '../ui/select'

const GOOGLE_METHODS: readonly AntigravityChatAuthConfig['method'][] = [
  'oauth-personal',
  'oauth-business'
]
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
      return t('accounts.antigravity.personal', 'Google account')
    case 'oauth-business':
      return t('accounts.antigravity.enterprise', 'Gemini Enterprise')
    case 'gemini-api-key':
      return t('accounts.antigravity.apiKey', 'Gemini API key')
    case 'agent-platform':
      return t('accounts.antigravity.agentPlatform', 'Agent Platform (ADC)')
    default:
      return null
  }
}

function methodDescription(method: AntigravityChatAuthConfig['method'], t: Translate): string {
  switch (method) {
    case 'oauth-personal':
      return t('accounts.antigravity.personalOption', 'Your personal Google AI plan')
    case 'oauth-business':
      return t('accounts.antigravity.enterpriseOption', "Your organization's license")
    case 'gemini-api-key':
      return t(
        'accounts.antigravity.apiKeyOption',
        'Uses GEMINI_API_KEY from your shell or Antigravity’s environment variables'
      )
    case 'agent-platform':
      return t(
        'accounts.antigravity.agentPlatformOption',
        'Uses this host’s Google Cloud Application Default Credentials'
      )
  }
}

/** The account types the host's Antigravity chat can sign in with; older hosts offer only Google's. */
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
