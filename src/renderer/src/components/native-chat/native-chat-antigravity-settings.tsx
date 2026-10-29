import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { agentSessionSignInFor } from '../../../../shared/agent-session-sign-in'

export function nativeChatAntigravitySignInContent(
  failureKind: string | undefined,
  agentName: string | undefined
): React.JSX.Element | undefined {
  if (failureKind !== 'notSignedIn' || agentSessionSignInFor(agentName)?.agent !== 'antigravity') {
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
          <a
            href="#accounts-antigravity"
            className="text-chat-foreground underline underline-offset-2 hover:text-chat-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault()
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
