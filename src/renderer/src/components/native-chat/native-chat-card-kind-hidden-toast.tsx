import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const NATIVE_CHAT_CARD_KIND_HIDDEN_TOAST_ID = 'native-chat-card-kind-hidden'
// Long enough to reach the link; Settings stays reachable after it goes.
const NATIVE_CHAT_CARD_KIND_HIDDEN_TOAST_DURATION_MS = 10_000

/** Turns a chat card kind off everywhere and says once where to turn it back on. */
export function hideNativeChatCardKind(
  updates: Partial<GlobalSettings>,
  settingsSectionId: string
): void {
  const { updateSettingsOrThrow, openSettingsPage, openSettingsTarget } = useAppStore.getState()
  void updateSettingsOrThrow(updates).then(
    () =>
      toast.success(
        translate('components.native-chat.cardKindHidden.title', "We won't show these anymore."),
        {
          id: NATIVE_CHAT_CARD_KIND_HIDDEN_TOAST_ID,
          description: (
            <p className="text-sm text-popover-foreground/80">
              {translate(
                'components.native-chat.cardKindHidden.description',
                'You can change this anytime in'
              )}{' '}
              <button
                type="button"
                onClick={() => {
                  openSettingsPage()
                  openSettingsTarget({ pane: 'chat', repoId: null, sectionId: settingsSectionId })
                  toast.dismiss(NATIVE_CHAT_CARD_KIND_HIDDEN_TOAST_ID)
                }}
                className="cursor-pointer font-medium text-popover-foreground underline underline-offset-2 hover:text-primary"
              >
                {translate('components.native-chat.cardKindHidden.settingsLink', 'Settings › Chat')}
              </button>
              .
            </p>
          ),
          duration: NATIVE_CHAT_CARD_KIND_HIDDEN_TOAST_DURATION_MS,
          dismissible: true
        }
      ),
    () =>
      toast.error(
        translate('components.native-chat.cardKindHidden.failed', 'Could not save that setting.')
      )
  )
}
