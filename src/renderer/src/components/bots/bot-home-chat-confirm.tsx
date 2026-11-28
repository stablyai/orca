import {
  botSwitchExplicitAskCopy,
  botSwitchPermissionCopy
} from '../../../../shared/agent-session/options/permissions/provider-switch-permission-copy'
import type { BotAgentSwitchPreviewResult } from '../../../../shared/rpc-contract/bot-agent-switch-params'
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
  preview?: BotAgentSwitchPreviewResult
) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    (bot, next, preview) => {
      const consent = preview?.consent
      const agent = botAgentLabel(next)
      return confirm({
        title: translate('bots.agentSwitch.title', 'Switch {{name}} to {{agent}}?', {
          name: bot.name,
          agent
        }),
        description: preview
          ? translate(
              'bots.agentSwitch.allInstancesDescription',
              'Home Chat, existing rooms and threads, and new chats use {{agent}} on their next reply.',
              { agent }
            )
          : translate(
              'bots.agentSwitch.description',
              "{{name}}'s Home Chat starts fresh on {{agent}}. The current conversation stays in history.",
              { name: bot.name, agent }
            ),
        details: preview ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              {translate(
                'bots.agentSwitch.allInstancesContinue',
                'Home Chat, existing rooms and other chats continue on {{agent}} with their recent history',
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
                'bots.agentSwitch.activeRepliesFinish',
                'Active replies finish on their current agent before switching'
              )}
            </li>
            <li>
              {translate('bots.agentSwitch.kept', 'Kept: soul, memory, automations, connectors')}
            </li>
            {consent ? <li>{botSwitchPermissionCopy(consent, translate).join(' ')}</li> : null}
            {preview.saveExplicitAsk ? <li>{botSwitchExplicitAskCopy(translate)}</li> : null}
          </ul>
        ) : (
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
        confirmLabel: consent
          ? translate('bots.agentSwitch.allowAction', 'Allow access and switch')
          : translate('bots.agentSwitch.action', 'Switch to {{agent}}', { agent }),
        aboveMenus: true
      })
    },
    [confirm]
  )
}
