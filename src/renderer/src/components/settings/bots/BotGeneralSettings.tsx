// A bot's general settings, one subpage each: its agent and model, and its permissions.
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { useConfirmBotAgentSwitch } from '@/components/bots/bot-home-chat-confirm'
import { useBotAgentMenu } from '@/components/bots/use-bot-agent-choices'
import { BotAgentLaunchPicker, type BotAgentSetup } from '@/components/bots/BotAgentLaunchPicker'
import { botErrorMessage } from '@/components/bots/bot-presentation'
import {
  NATIVE_CHAT_PERMISSION_MODE_ICONS,
  nativeChatPermissionModeDescription,
  nativeChatPermissionModeLabel
} from '@/components/native-chat/session/options/controls/native-chat-permission-mode-labels'
import {
  SettingsInsetGroup,
  SettingsInsetRow
} from '@/components/bots/settings-view/BotSettingsRows'
import { useTranslate } from '@/i18n/use-translate'
import { openBotChat } from '@/lib/bot-catalog'
import {
  AGENT_CHAT_PERMISSION_MODES,
  type AgentChatPermissionMode
} from '../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  agentChatPermissionModes,
  chatAsksNoApprovals,
  savedChatPermissionMode
} from '../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { BotClaudeAccountPicker } from './BotClaudeAccountPicker'
import { useBotSettingsModel } from './use-bot-settings-model'

type Update = (updates: BotUpdateParams['updates']) => Promise<Bot | null>

/** Agent and model: the picker, under its label at any width; switching agents asks first. */
export function BotAgentSettings({ bot, update }: { bot: Bot; update: Update }): React.JSX.Element {
  const t = useTranslate()
  const menu = useBotAgentMenu(bot.hostId, true, bot.agent)
  const worktreeId = folderWorkspaceKey(bot.folderWorkspaceId)
  const defaultModelHint = useBotSettingsModel(bot, worktreeId)
  const confirmAgentSwitch = useConfirmBotAgentSwitch()
  // The permission has its own subpage; the picker sets the agent and what it runs on.
  const setAgentSetup = async ({ agent, launch }: BotAgentSetup): Promise<void> => {
    if (agent === bot.agent) {
      if (JSON.stringify(launch) !== JSON.stringify(bot.launch)) {
        await update({ launch: launch ?? null })
      }
      return
    }
    if (
      !(await confirmAgentSwitch(bot, agent)) ||
      !(await update({ agent, launch: launch ?? null }))
    ) {
      return
    }
    // The Home Chat starts fresh now, not on its next message, so its tab already runs the new agent.
    await openBotChat(bot).catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  return (
    <SettingsInsetGroup>
      <AgentField
        label={t('settings.bots.agent', 'Agent')}
        description={t(
          'settings.bots.agentModelDescription',
          'Used for bot conversations and automations. A new model applies to new conversations; the Home Chat keeps its current one.'
        )}
      >
        <BotAgentLaunchPicker
          model={menu.model}
          choices={menu.choices}
          value={{ agent: bot.agent, launch: bot.launch, permissionMode: bot.permissionMode }}
          worktreeId={worktreeId}
          defaultModelHint={defaultModelHint}
          withPermission={false}
          onChange={(setup) => void setAgentSetup(setup)}
        />
      </AgentField>
      {/* Only Claude chats launch under a bot's own account. */}
      {bot.agent === 'claude' ? (
        <AgentField
          label={t('settings.bots.claudeAccount', 'Claude account')}
          description={t(
            'settings.bots.claudeAccountDescription',
            'Used for the bot’s Claude conversations. A new account applies to new conversations, and to the Home Chat when it next starts.'
          )}
        >
          <BotClaudeAccountPicker bot={bot} update={update} />
        </AgentField>
      ) : null}
    </SettingsInsetGroup>
  )
}

/** One setting of the agent page: its control under its label at any width. */
function AgentField({
  label,
  description,
  children
}: {
  label: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="min-w-0 text-[13px]">
        <div className="font-medium leading-[18px]">{label}</div>
        <p className="text-xs leading-4 text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  )
}

/** The bot's starting permission for new sessions; "Same as chats" follows the chat setting. */
export function BotPermissionSettings({
  bot,
  update
}: {
  bot: Bot
  update: Update
}): React.JSX.Element {
  const t = useTranslate()
  const support = agentChatPermissionModes(bot.agent)
  const asksNoApprovals = chatAsksNoApprovals(bot.agent)
  const saved =
    support && bot.permissionMode
      ? savedChatPermissionMode(support, bot.permissionMode)
      : bot.permissionMode
  // An agent that asks no approvals only ever runs with full access.
  const current: AgentChatPermissionMode | null = asksNoApprovals ? 'full-access' : (saved ?? null)
  const modes: readonly AgentChatPermissionMode[] = asksNoApprovals
    ? ['full-access']
    : (support?.modes ?? AGENT_CHAT_PERMISSION_MODES)
  const picked = (on: boolean): React.ReactNode =>
    on ? <Check aria-hidden className="size-4 text-foreground" /> : null
  const choice = (
    key: string,
    on: boolean,
    row: Omit<React.ComponentProps<typeof SettingsInsetRow>, 'end' | 'onOpen'>,
    select: () => void
  ): React.JSX.Element => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      data-row-icon={row.icon ? '' : undefined}
      disabled={asksNoApprovals}
      onClick={select}
      className="block w-full text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 disabled:pointer-events-none"
    >
      <SettingsInsetRow {...row} wrapDetail end={picked(on)} />
    </button>
  )
  return (
    <div role="radiogroup" aria-label={t('settings.bots.permissions', 'Permissions')}>
      <SettingsInsetGroup
        foot={
          asksNoApprovals
            ? undefined
            : t(
                'settings.bots.permissionsDescription',
                'The starting permission for new sessions. Anything beyond it asks in the session.',
                { name: bot.name }
              )
        }
      >
        {asksNoApprovals
          ? null
          : choice(
              'inherit',
              current === null,
              {
                title: t('settings.bots.permissionSameAsChats', 'Same as chats'),
                detail: t(
                  'settings.bots.permissionSameAsChatsDescription',
                  'Starts like any new chat, from your chat permission setting.'
                )
              },
              () => void update({ permissionMode: null })
            )}
        {modes.map((mode) => {
          const Icon = NATIVE_CHAT_PERMISSION_MODE_ICONS[mode]
          return choice(
            mode,
            current === mode,
            {
              icon: <Icon />,
              title: nativeChatPermissionModeLabel(mode, t),
              detail: nativeChatPermissionModeDescription(mode, bot.agent, t)
            },
            () => void update({ permissionMode: mode })
          )
        })}
      </SettingsInsetGroup>
    </div>
  )
}
