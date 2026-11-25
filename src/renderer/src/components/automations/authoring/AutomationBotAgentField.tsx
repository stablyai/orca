// A bot automation's agent: the bot's, or its own agent and model for runs in a new conversation.
import { BotAgentLaunchPicker } from '@/components/bots/BotAgentLaunchPicker'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { useBotAgentMenu } from '@/components/bots/use-bot-agent-choices'
import { launchModelLabel } from '@/components/agent/AgentLaunchPicker'
import { useTranslate } from '@/i18n/use-translate'
import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../../shared/bot-types'
import { botAutomationSetup } from '../../../../../shared/bots/bot-agent-setup'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from '../automation-page-parts'

/** "Claude Code · Opus 5.5": what the bot's own setup runs. */
function botSetupDetail(bot: Pick<Bot, 'agent' | 'launch'>): string {
  const model = launchModelLabel(bot.agent, bot.launch?.model)
  return [botAgentLabel(bot.agent), model].filter(Boolean).join(' · ')
}

export function AutomationBotAgentField({
  target,
  bot,
  onChange
}: {
  target: AutomationBotTarget
  bot: Pick<Bot, 'name' | 'agent' | 'launch' | 'hostId' | 'folderWorkspaceId'>
  onChange: (target: AutomationBotTarget) => void
}): React.JSX.Element {
  const t = useTranslate()
  const setup = botAutomationSetup(target, bot)
  const menu = useBotAgentMenu(bot.hostId, true, setup.agent)
  // A run in a chat continues that chat, whichever agent it is on.
  const inChat = target.runsIn !== 'new'
  return (
    <Field
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={t('automations.botTarget.agent', 'Agent')}
    >
      <BotAgentLaunchPicker
        model={menu.model}
        choices={menu.choices}
        value={{ agent: setup.agent, ...(setup.launch ? { launch: setup.launch } : {}) }}
        worktreeId={folderWorkspaceKey(bot.folderWorkspaceId)}
        withPermission={false}
        disabled={inChat}
        inherit={
          inChat
            ? {
                label: t('automations.botTarget.agentInChat', "This chat's agent"),
                chosen: true,
                onChoose: () => {}
              }
            : {
                label: t('automations.botTarget.agentSameAsBot', 'Same as {{name}}', {
                  name: bot.name
                }),
                detail: botSetupDetail(bot),
                agent: bot.agent,
                chosen: !setup.own,
                onChoose: () => {
                  const { agentSetup: _dropped, ...rest } = target
                  onChange(rest)
                }
              }
        }
        onChange={({ agent, launch }) =>
          onChange({ ...target, agentSetup: { agent, ...(launch ? { launch } : {}) } })
        }
      />
      {inChat ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'automations.botTarget.agentInChatHelp',
            "A run in a chat continues on that chat's agent."
          )}
        </p>
      ) : null}
    </Field>
  )
}
