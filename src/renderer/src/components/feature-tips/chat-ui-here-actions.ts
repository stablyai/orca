import { toast } from 'sonner'
import type { AgentDefaultSurface } from '../../../../shared/native-chat/native-chat-appearance-settings'
import { normalizeAgentDefaultSurface } from '../../../../shared/native-chat/native-chat-providers'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { CHAT_LAUNCH_DEFAULT_SECTION_ID } from '../settings/chat/chat-launch-search'
import {
  trackAgentDefaultSurfaceChanged,
  trackChatUiFeatureTipAction
} from './feature-tip-telemetry'

export async function setAgentDefaultSurfaceFromFeatureTip(
  surface: AgentDefaultSurface,
  { confirmWithToast = true }: { confirmWithToast?: boolean } = {}
): Promise<boolean> {
  const { settings, updateSettingsOrThrow } = useAppStore.getState()
  const fromSurface = normalizeAgentDefaultSurface(settings?.agentDefaultSurface)
  try {
    // Explicit per-agent choices survive a change to the default.
    await updateSettingsOrThrow({ agentDefaultSurface: surface })
    trackChatUiFeatureTipAction(
      surface === 'chat' ? 'chat-ui-off' : 'chat-ui-on',
      surface === 'chat' ? 'use_chat_ui' : 'switch_to_terminal'
    )
    trackAgentDefaultSurfaceChanged({
      from_mode: fromSurface,
      to_mode: surface,
      source: 'launch_card',
      launch_tip_shown: true
    })
    if (surface === 'chat' && confirmWithToast) {
      toast.success(
        translate(
          'featureTips.chatUiHere.switched',
          'Chat UI is now the default for new agents. You can switch back any time in Settings → Chat UI.'
        )
      )
    }
    return true
  } catch {
    toast.error(
      surface === 'chat'
        ? translate(
            'featureTips.chatUiHere.saveFailed',
            'Could not turn on Chat UI. Turn it on in Settings → Chat UI.'
          )
        : translate(
            'featureTips.chatUiHere.terminalSaveFailed',
            'Could not switch to terminal. Turn off Chat UI in Settings → Chat UI.'
          )
    )
    return false
  }
}

export function openChatUiFeatureTipSettings(): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({ pane: 'chat', repoId: null, sectionId: CHAT_LAUNCH_DEFAULT_SECTION_ID })
  openSettingsPage()
}

/** Opens Settings already searching "Chat UI", the term the switched note tells users to search. */
export function openChatUiSettingsSearch(): void {
  const { openSettingsPage, openSettingsTarget, setSettingsSearchQuery } = useAppStore.getState()
  // Why this order: openSettingsPage clears the search query.
  openSettingsPage()
  openSettingsTarget({ pane: 'chat', repoId: null })
  setSettingsSearchQuery(translate('settings.appearance.chat.title', 'Chat UI'))
}
