import { toast } from 'sonner'
import type { AgentDefaultSurface } from '../../../../shared/native-chat/native-chat-appearance-settings'
import { normalizeAgentDefaultSurface } from '../../../../shared/native-chat/native-chat-providers'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { AGENT_DEFAULT_SURFACE_SECTION_ID } from '../settings/agents-search'
import {
  trackAgentDefaultSurfaceChanged,
  trackChatUiFeatureTipAction
} from './feature-tip-telemetry'

export async function setAgentDefaultSurfaceFromFeatureTip(
  surface: AgentDefaultSurface
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
    return true
  } catch {
    toast.error(
      surface === 'chat'
        ? translate(
            'featureTips.chatUiHere.saveFailed',
            'Could not turn on Chat UI. Choose Chat in Settings → Agents.'
          )
        : translate(
            'featureTips.chatUiHere.terminalSaveFailed',
            'Could not switch to terminal. Choose Terminal in Settings → Agents.'
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
