import { useAppStore } from '@/store'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_SETTING_SECTION_ID } from '../../settings/chat/native-chat-usage-limit-continue-setting-target'

/** Whether Orca will send the continue itself at the reset, as a usage-limit row shows it. */
export type NativeChatUsageLimitAutoContinueState =
  | { kind: 'off' }
  | { kind: 'scheduled'; resetsAt: number; cancel: () => void; cancelDisabled?: boolean }
  | { kind: 'cancelled' }

export function openUsageLimitContinueSetting(): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({
    pane: 'chat',
    repoId: null,
    // Only this machine's chats link here, whatever host the Settings picker last showed.
    hostScope: { kind: 'local' },
    sectionId: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_SETTING_SECTION_ID
  })
  openSettingsPage()
}
