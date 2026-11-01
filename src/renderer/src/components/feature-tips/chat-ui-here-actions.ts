import { toast } from 'sonner'
import { normalizeAgentDefaultSurface } from '../../../../shared/native-chat/native-chat-providers'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { AGENT_DEFAULT_SURFACE_SECTION_ID } from '../settings/agents-search'
import {
  trackAgentDefaultSurfaceChanged,
  trackChatUiFeatureTipAction
} from './feature-tip-telemetry'

export async function enableChatUiFromFeatureTip(): Promise<boolean> {
  const { settings, updateSettingsOrThrow } = useAppStore.getState()
  const fromSurface = normalizeAgentDefaultSurface(settings?.agentDefaultSurface)
  try {
    // Explicit per-agent choices survive a change to the default.
    await updateSettingsOrThrow({ agentDefaultSurface: 'chat' })
    trackChatUiFeatureTipAction('chat-ui-off', 'use_chat_ui')
    trackAgentDefaultSurfaceChanged({
      from_mode: fromSurface,
      to_mode: 'chat',
      source: 'launch_card',
      launch_tip_shown: true
    })
    return true
  } catch {
    toast.error(
      translate(
        'featureTips.chatUiHere.saveFailed',
        'Could not turn on Chat UI. Choose Chat in Settings → Agents.'
      )
    )
    return false
  }
}

export function openChatUiFeatureTipSettings(): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({
    pane: 'agents',
    repoId: null,
    hostScope: { kind: 'local' },
    sectionId: AGENT_DEFAULT_SURFACE_SECTION_ID
  })
  openSettingsPage()
}
