import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { openAntigravitySignInSettings } from '@/components/provider-accounts/open-antigravity-sign-in-settings'
import { agentSessionSetupFor } from '../../../../../shared/agent-session/lifecycle/agent-session-setup-commands'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { NativeChatActionButton } from '../composer/controls/NativeChatActionButton'
import { useNativeChatHostSetupView } from './native-chat-host-setup'

/** Links Orca's own Antigravity sign-in; chats on the host's agy (`system`) use agy's instead. */
export function nativeChatAntigravitySignInContent(
  failureKind: string | undefined,
  agentName: string | undefined,
  account?: string,
  t: Translate = translate,
  /** The chat's host; transcript rows leave it out and read it from the chat's setup context. */
  host?: RuntimeClientTarget
): React.JSX.Element | undefined {
  if (
    failureKind !== 'notSignedIn' ||
    account === 'system' ||
    agentSessionSetupFor(agentName)?.agent !== 'antigravity'
  ) {
    return undefined
  }
  return (
    <Trans
      i18n={i18n}
      defaults={t(
        'components.native-chat.antigravitySignIn.sentence',
        "Antigravity isn't signed in. Sign in under <settings>Settings → Accounts → Antigravity</settings>. Then send your message again."
      )}
      components={{
        settings: <AntigravitySignInSettingsLink host={host} />
      }}
    />
  )
}

function AntigravitySignInSettingsLink(props: {
  host: RuntimeClientTarget | undefined
  children?: React.ReactNode
}): React.JSX.Element {
  const setup = useNativeChatHostSetupView()
  return (
    <NativeChatActionButton
      primary
      href="#accounts-antigravity"
      onClick={() => openAntigravitySignInSettings(props.host ?? setup?.host)}
    >
      {props.children}
    </NativeChatActionButton>
  )
}
