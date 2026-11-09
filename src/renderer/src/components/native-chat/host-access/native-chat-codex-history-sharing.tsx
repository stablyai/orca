import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { CODEX_HISTORY_SHARING_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { NativeChatActionButton } from '../composer/controls/NativeChatActionButton'

/** Links the sharing setting a Codex chat needs when its selected account lacks the conversation. */
export function nativeChatCodexHistorySharingContent(
  failureKind: string | undefined,
  t: Translate = translate
): React.JSX.Element | undefined {
  if (failureKind !== 'codexHistoryNotShared') {
    return undefined
  }
  return (
    <Trans
      i18n={i18n}
      defaults={t(
        'components.native-chat.codexHistorySharing.sentence',
        "The selected Codex account doesn't have this chat's history, and Share Codex history across accounts is off. Turn it on in <settings>Settings → Agents</settings>, or switch back to the account this chat ran on."
      )}
      components={{
        settings: (
          <NativeChatActionButton
            primary
            href={`#${CODEX_HISTORY_SHARING_SETTINGS_TARGET_ID}`}
            onClick={() => {
              const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
              openSettingsTarget({
                pane: 'agents',
                repoId: null,
                sectionId: CODEX_HISTORY_SHARING_SETTINGS_TARGET_ID
              })
              openSettingsPage()
            }}
          />
        )
      }}
    />
  )
}
