import { useCallback } from 'react'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { persistConfirmationSkipPreference } from '@/components/dismiss/confirmation/confirmation-skip-preference'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Bot, BotAgent } from '../../../../shared/bot-types'
import { BOTS_SETTINGS_SECTION_ID } from '../settings/bots/bot-settings-section-ids'
import { botAgentLabel } from './bot-presentation'

/** A new Home Chat drops only the conversation, so the owner hears what stays before it goes. */
export function useConfirmNewHomeChat(): (bot: Pick<Bot, 'name'>) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    async (bot) => {
      const { settings, updateSettings, openSettingsPage, openSettingsTarget } =
        useAppStore.getState()
      if (settings?.skipNewHomeChatConfirm) {
        return true
      }
      return confirm({
        title: translate('bots.newHomeChat.title', 'Start a new Home Chat?'),
        description: translate(
          'bots.newHomeChat.description',
          '{{name}} keeps its soul and memory, but not this conversation.',
          { name: bot.name }
        ),
        confirmLabel: translate('bots.newHomeChat.action', 'New Home Chat'),
        dontAskAgain: {
          onConfirmed: () =>
            persistConfirmationSkipPreference({
              updates: { skipNewHomeChatConfirm: true },
              settingsSectionId: BOTS_SETTINGS_SECTION_ID,
              updateSettings,
              openSettingsPage,
              // The switch to ask again lives in Settings › Bots, not General.
              openSettingsTarget: () => openSettingsTarget({ pane: 'bots', repoId: null })
            })
        }
      })
    },
    [confirm]
  )
}

export function useConfirmBotAgentSwitch(): (
  bot: Pick<Bot, 'name' | 'agent'>,
  next: BotAgent,
  broaderAccess?: boolean
) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    (bot, next, broaderAccess) => {
      const agent = botAgentLabel(next)
      return confirm({
        title: translate('bots.agentSwitch.title', 'Switch {{name}} to {{agent}}?', {
          name: bot.name,
          agent
        }),
        description: translate(
          'bots.agentSwitch.description',
          'Home Chat and new chats use {{agent}}. Your other chats keep their agent. Change any of them from its own picker.',
          { agent }
        ),
        details: (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              {translate(
                'bots.agentSwitch.homeContinues',
                'Home Chat continues on {{agent}} with its recent history',
                { agent }
              )}
            </li>
            <li>
              {translate(
                'bots.agentSwitch.newChats',
                'New Slack threads, automation runs and chats you open later start on {{agent}}',
                { agent }
              )}
            </li>
            <li>
              {translate(
                'bots.agentSwitch.threads',
                "Slack threads with an existing Orca chat keep that chat's agent"
              )}
            </li>
            <li>
              {translate('bots.agentSwitch.kept', 'Kept: soul, memory, automations, connectors')}
            </li>
            {broaderAccess ? (
              <li>
                {translate(
                  'bots.agentSwitch.broaderAccess',
                  'Orca can’t require {{agent}} to ask before using tools. Allowing this applies to Home Chat and new work on this default.',
                  { agent }
                )}
              </li>
            ) : null}
          </ul>
        ),
        confirmLabel: broaderAccess
          ? translate('bots.agentSwitch.allowAction', 'Allow access and switch')
          : translate('bots.agentSwitch.action', 'Switch to {{agent}}', { agent })
      })
    },
    [confirm]
  )
}
