import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { agentSessionSignInFor } from '../../../../shared/agent-session/lifecycle/agent-session-sign-in'
import { NativeChatActionButton } from './NativeChatActionButton'

/** Links Orca's own Antigravity sign-in; chats on the host's agy (`system`) use agy's instead. */
export function nativeChatAntigravitySignInContent(
  failureKind: string | undefined,
  agentName: string | undefined,
  account?: string
): React.JSX.Element | undefined {
  if (
    failureKind !== 'notSignedIn' ||
    account === 'system' ||
    agentSessionSignInFor(agentName)?.agent !== 'antigravity'
  ) {
    return undefined
  }
  return (
    <Trans
      i18n={i18n}
      defaults={translate(
        'components.native-chat.antigravitySignIn.sentence',
        "Antigravity isn't signed in. Sign in under <settings>Settings → Accounts → Antigravity</settings>. Then send your message again."
      )}
      components={{
        settings: (
          <NativeChatActionButton
            primary
            href="#accounts-antigravity"
            onClick={() => {
              const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
              openSettingsTarget({
                pane: 'accounts',
                repoId: null,
                sectionId: 'accounts-antigravity'
              })
              openSettingsPage()
            }}
          />
        )
      }}
    />
  )
}
