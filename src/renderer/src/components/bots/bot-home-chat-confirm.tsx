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

/** Another agent can't carry the conversation, so a switch starts the Home Chat fresh. */
export function useConfirmBotAgentSwitch(): (
  bot: Pick<Bot, 'name' | 'agent'>,
  next: BotAgent
) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    (bot, next) => {
      const agent = botAgentLabel(next)
      return confirm({
        title: translate('bots.agentSwitch.title', 'Switch {{name}} to {{agent}}?', {
          name: bot.name,
          agent
        }),
        description: translate(
          'bots.agentSwitch.description',
          "{{name}}'s Home Chat starts fresh on {{agent}}. The current conversation stays in history.",
          { name: bot.name, agent }
        ),
        details: (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              {translate('bots.agentSwitch.kept', 'Kept: soul, memory, automations, connectors')}
            </li>
            <li>{translate('bots.agentSwitch.notKept', 'Not kept: the current conversation')}</li>
            <li>
              {translate(
                'bots.agentSwitch.threads',
                "Slack threads with an existing Orca chat keep that chat's agent"
              )}
            </li>
          </ul>
        ),
        confirmLabel: translate('bots.agentSwitch.action', 'Switch to {{agent}}', { agent }),
        // A tab in the bot's agent picker switches agents with the picker still open.
        aboveMenus: true
      })
    },
    [confirm]
  )
}
