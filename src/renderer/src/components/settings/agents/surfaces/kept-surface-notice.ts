import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { AgentDefaultSurface } from '../../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { normalizeAgentDefaultSurface } from '../../../../../../shared/native-chat/settings/native-chat-providers'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useAppStore } from '@/store/index'
import {
  agentsKeepingOwnSurface,
  followAgentDefaultSurface
} from '../../../../lib/agent-session/launch/native-chat-provider-choice'

export function agentSettingsSaveFailed(): void {
  toast.error(
    translate('settings.agents.localSaveFailed', 'Agent settings could not be saved. Try again.')
  )
}

export type KeptSurfaceWriter = {
  fallbackSettings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** After the default changes, names the agents set for themselves to the other surface; returns whether it did. */
export function showKeptSurfaceNotice({
  id,
  surface,
  writer
}: {
  id: string
  surface: AgentDefaultSurface
  writer: KeptSurfaceWriter
}): boolean {
  const latest = useAppStore.getState().settings ?? writer.fallbackSettings
  // A superseded write leaves nothing to report.
  if (normalizeAgentDefaultSurface(latest.agentDefaultSurface) !== surface) {
    return false
  }
  const kept = agentsKeepingOwnSurface(latest, surface)
  if (kept.length === 0) {
    toast.dismiss(id)
    return false
  }
  const values = {
    agents: new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(
      kept.map((agent) => getAgentLabel(agent))
    ),
    count: kept.length
  }
  const chat = surface === 'chat'
  toast.success(
    chat
      ? translate('settings.agents.defaultSurfaceNowChat', 'Agents now open as chats')
      : translate('settings.agents.defaultSurfaceNowTerminal', 'Agents now open in the terminal'),
    {
      id,
      description: chat
        ? translate(
            'settings.agents.defaultSurfaceKeptTerminal',
            '{{agents}} stay in the terminal, as you set.',
            {
              ...values,
              count: values.count,
              defaultValue_one: '{{agents}} stays in the terminal, as you set.'
            }
          )
        : translate(
            'settings.agents.defaultSurfaceKeptChat',
            '{{agents}} stay as chats, as you set.',
            {
              ...values,
              count: values.count,
              defaultValue_one: '{{agents}} stays as a chat, as you set.'
            }
          ),
      action: {
        label: chat
          ? translate('settings.agents.defaultSurfaceSetAllChat', 'Set all to Chat')
          : translate('settings.agents.defaultSurfaceSetAllTerminal', 'Set all to Terminal'),
        onClick: () =>
          void followAgentDefaultSurface({ agents: kept, surface, ...writer }).catch(
            agentSettingsSaveFailed
          )
      }
    }
  )
  return true
}
