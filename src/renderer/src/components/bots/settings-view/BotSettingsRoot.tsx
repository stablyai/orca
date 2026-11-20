// The settings view's root: the bot's card, then Agent, Schedule, Soul and memory, Access and Notifications, then Delete.
import { useContext, useState } from 'react'
import {
  Activity,
  BookOpen,
  Bot as BotIcon,
  Brain,
  Eye,
  Laptop,
  Moon,
  Plug,
  Server,
  Share2,
  Shield,
  Smile,
  Trash2,
  Users,
  Wrench
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAccessRequests } from '@/lib/bot-access-requests'
import { useAppStore } from '@/store'
import { nativeChatPermissionModeLabel } from '@/components/native-chat/session/options/controls/native-chat-permission-mode-labels'
import { savedChatPermissionMode } from '../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  agentChatPermissionModes,
  chatAsksNoApprovals
} from '../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import { botMembersFrom, type Bot } from '../../../../../shared/bot-types'
import { botLookAround, lookAroundSupported } from '../../../../../shared/bots/bot-look-around'
import { botTidyUp } from '../../../../../shared/bots/bot-tidy-up'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import type { BotHome } from '../../settings/bots/bot-home-files'
import { useBotMemoryTopicCount } from '../../settings/bots/use-bot-memory-topics'
import { useBotNotificationToggles } from '../../settings/bots/use-bot-notification-toggles'
import { useBotPictureSetting } from '../../settings/bots/use-bot-picture-setting'
import { BotNameInlineEdit } from '../BotNameInlineEdit'
import { BotPictureButton } from '../BotPictureButton'
import { ACCOUNT_CONNECTORS, useBotConnectorState } from '../bot-connectors'
import { botAgentLabel, botFolderDisplay } from '../bot-presentation'
import {
  lookAroundLine,
  memoryLine,
  namesLine,
  tidyUpLine,
  toolsLine,
  whoCanAskLine
} from '../bot-settings-row-states'
import { useBotSoulDescription } from '../bot-soul-description'
import { useBotTools } from '../bot-tool-checks'
import { useBotActivity } from '../use-bot-activity'
import { useBotTidyUp } from '../use-bot-tidy-up'
import { useDeleteBot } from '../use-delete-bot'
import { BotShareFlow } from '../sharing/BotShareFlow'
import { BotSharedFromLine } from './BotSharedFromLine'
import { BotSharingGroup } from './BotSharingPage'
import { useBotComputerName } from './BotComputerPage'
import type { BotSettingsPage } from './bot-settings-place'
import { SettingsControlsOffContext, SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'
import { BotItemsSettingsGroup } from './BotItemsSettingsGroup'

type Update = (updates: BotUpdateParams['updates']) => Promise<Bot | null>

function useAccessLines(bot: Bot): { connectors: string; whoCanAsk: string } {
  const intlLocale = useIntlLocale()
  const state = useBotConnectorState(bot)
  const requests = useAccessRequests().filter(
    (request) => request.botId === bot.id && request.hostId === bot.hostId
  ).length
  return {
    connectors: namesLine(
      state.catalog.filter(state.added).map((connector) => connector.label),
      intlLocale
    ),
    whoCanAsk: whoCanAskLine(
      ACCOUNT_CONNECTORS.filter((connector) => connector.id !== 'google').map((connector) => ({
        label: connector.label,
        people: botMembersFrom(bot.members, connector.id).length
      })),
      requests
    )
  }
}

function permissionLine(bot: Bot, t: ReturnType<typeof useTranslate>): string {
  if (chatAsksNoApprovals(bot.agent)) {
    return nativeChatPermissionModeLabel('full-access', t)
  }
  const support = agentChatPermissionModes(bot.agent)
  const mode =
    support && bot.permissionMode
      ? savedChatPermissionMode(support, bot.permissionMode)
      : bot.permissionMode
  return mode
    ? nativeChatPermissionModeLabel(mode, t)
    : t('settings.bots.permissionSameAsChats', 'Same as chats')
}

function ScheduleGroup({
  bot,
  update,
  open
}: {
  bot: Bot
  update: Update
  open: (page: BotSettingsPage) => void
}): React.JSX.Element {
  const t = useTranslate()
  const lookAround = botLookAround(bot)
  const tidyUp = botTidyUp(bot)
  const { upNext } = useBotActivity(bot)
  const { view: tidyView } = useBotTidyUp(bot)
  const lookAroundTitle = t('settings.bots.lookAround.title', 'Look around')
  const tidyUpTitle = t('settings.bots.tidyUp.title', 'Memory upkeep')
  return (
    <SettingsInsetGroup
      title={t('bots.settingsView.schedule', 'Schedule')}
      foot={t('bots.settingsView.automationsFoot', 'Automations are in Home › Automations.')}
    >
      <SettingsInsetRow
        icon={<Eye />}
        title={lookAroundTitle}
        detail={lookAroundLine(lookAround, upNext?.state.lastLookedAt)}
        page="look-around"
        onOpen={() => open('look-around')}
        end={
          <Switch
            checked={lookAround.on}
            aria-label={lookAroundTitle}
            onCheckedChange={() => void update({ lookAround: { on: !lookAround.on } })}
          />
        }
      />
      <SettingsInsetRow
        icon={<Moon />}
        title={tidyUpTitle}
        detail={tidyUpLine(tidyUp, tidyView?.last?.at)}
        page="tidy-up"
        onOpen={() => open('tidy-up')}
        end={
          <Switch
            checked={tidyUp.on}
            aria-label={tidyUpTitle}
            onCheckedChange={() => void update({ tidyUp: { on: !tidyUp.on } })}
          />
        }
      />
    </SettingsInsetGroup>
  )
}

function SoulAndMemoryGroup({
  home,
  open
}: {
  home: BotHome
  open: (page: BotSettingsPage) => void
}): React.JSX.Element {
  const t = useTranslate()
  const soul = useBotSoulDescription(home)
  const topicFiles = useBotMemoryTopicCount(home)
  return (
    <SettingsInsetGroup title={t('bots.settingsView.soulAndMemory', 'Soul and memory')}>
      <SettingsInsetRow
        icon={<Smile />}
        title={t('settings.bots.soul', 'Soul')}
        detail={soul ?? 'SOUL.md'}
        page="soul"
        onOpen={() => open('soul')}
      />
      <SettingsInsetRow
        icon={<Brain />}
        title={t('settings.bots.memory', 'Memory')}
        detail={memoryLine(topicFiles)}
        page="memory"
        onOpen={() => open('memory')}
      />
    </SettingsInsetGroup>
  )
}

function AccessGroup({
  bot,
  open
}: {
  bot: Bot
  open: (page: BotSettingsPage) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const lines = useAccessLines(bot)
  const { view } = useBotTools(bot, 'finished')
  const repos = useAppStore((state) => state.repos)
  const skills = namesLine(
    (bot.skillProjects ?? []).flatMap(
      (id) => repos.find((repo) => repo.id === id)?.displayName ?? []
    ),
    intlLocale
  )
  return (
    <SettingsInsetGroup title={t('bots.settingsView.access', 'Access')}>
      <SettingsInsetRow
        icon={<Plug />}
        title={t('settings.bots.connectors', 'Connectors')}
        detail={lines.connectors}
        page="connectors"
        onOpen={() => open('connectors')}
      />
      <SettingsInsetRow
        icon={<Users />}
        title={t('bots.settingsView.whoCanAsk', 'Who can ask')}
        detail={lines.whoCanAsk}
        page="who-can-ask"
        onOpen={() => open('who-can-ask')}
      />
      <SettingsInsetRow
        icon={<Wrench />}
        title={t('settings.bots.tools.title', 'Tools')}
        detail={
          toolsLine(
            view.status === 'ready' ? view.tools : null,
            botAgentLabel(bot.agent),
            intlLocale
          ) ?? undefined
        }
        page="tools"
        onOpen={() => open('tools')}
      />
      <SettingsInsetRow
        icon={<BookOpen />}
        title={t('settings.bots.skills.title', 'Skills')}
        detail={skills}
        page="skills"
        onOpen={() => open('skills')}
      />
    </SettingsInsetGroup>
  )
}

function NotificationsGroup({ bot, update }: { bot: Bot; update: Update }): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsInsetGroup title={t('settings.bots.notifications', 'Notifications')}>
      {useBotNotificationToggles(bot).map((toggle) => (
        <SettingsInsetRow
          key={toggle.key}
          title={toggle.label}
          detail={toggle.description}
          wrapDetail
          end={
            <Switch
              checked={bot.notifications[toggle.key]}
              aria-label={toggle.label}
              onCheckedChange={() =>
                void update({
                  notifications: {
                    ...bot.notifications,
                    [toggle.key]: !bot.notifications[toggle.key]
                  }
                })
              }
            />
          }
        />
      ))}
    </SettingsInsetGroup>
  )
}

export function BotSettingsRoot({
  bot,
  home,
  update,
  open,
  onDeleted
}: {
  bot: Bot
  home: BotHome | null
  update: Update
  open: (page: BotSettingsPage) => void
  onDeleted: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const computer = useBotComputerName(bot)
  const deleteBot = useDeleteBot(bot)
  const controlsOff = useContext(SettingsControlsOffContext)
  const state = bot.paused
    ? t('bots.settingsPage.paused', 'Paused')
    : t('bots.settingsPage.active', 'Active')
  const model = bot.launch?.model ?? t('bots.settingsView.chatDefault', 'your chat default')
  const [sharing, setSharing] = useState(false)
  const picture = useBotPictureSetting(bot, update)
  return (
    <>
      {sharing ? <BotShareFlow bot={bot} onClose={() => setSharing(false)} /> : null}
      <div className="flex flex-wrap items-center gap-3 rounded-[10px] bg-foreground/[0.035] p-3">
        <div className="flex min-w-0 flex-1 basis-40 items-center gap-3">
          <fieldset disabled={controlsOff} className="contents">
            <BotPictureButton
              bot={bot}
              picture={picture}
              avatarClassName="size-10 rounded-[10px] text-lg"
              className="rounded-[10px]"
            />
          </fieldset>
          <div className="min-w-0 flex-1">
            <fieldset disabled={controlsOff} className="contents">
              <BotNameInlineEdit
                bot={bot}
                update={update}
                className="text-[15px] font-semibold leading-5"
              />
            </fieldset>
            <span className="block truncate text-xs leading-4 text-muted-foreground">
              {[botAgentLabel(bot.agent), state, computer].join(' · ')}
            </span>
            <BotSharedFromLine bot={bot} />
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="@max-[300px]/settings-view:w-full"
          disabled={controlsOff}
          onClick={() => setSharing(true)}
        >
          <Share2 />
          {t('bots.settingsView.share', 'Share…')}
        </Button>
      </div>
      <SettingsInsetGroup title={t('settings.bots.agent', 'Agent')}>
        <SettingsInsetRow
          icon={<BotIcon />}
          title={t('bots.settingsView.agent', 'Agent and model')}
          detail={`${botAgentLabel(bot.agent)} · ${model}`}
          page="agent"
          onOpen={() => open('agent')}
        />
        <SettingsInsetRow
          icon={<Shield />}
          title={t('settings.bots.permissions', 'Permissions')}
          detail={permissionLine(bot, t)}
          page="permissions"
          onOpen={() => open('permissions')}
        />
        <SettingsInsetRow
          icon={bot.hostId === 'local' ? <Laptop /> : <Server />}
          title={t('bots.settingsView.computer', 'Computer')}
          detail={`${computer} · ${botFolderDisplay(bot.folder)}`}
          page="computer"
          onOpen={() => open('computer')}
        />
        <SettingsInsetRow
          icon={<Activity />}
          title={t('settings.bots.active', 'Active')}
          detail={t('settings.bots.activeDescription', 'Answers messages and runs automations.')}
          end={
            <Switch
              checked={!bot.paused}
              aria-label={t('settings.bots.active', 'Active')}
              onCheckedChange={() => void update({ paused: !bot.paused })}
            />
          }
        />
      </SettingsInsetGroup>
      {lookAroundSupported(bot.agent) ? (
        <ScheduleGroup bot={bot} update={update} open={open} />
      ) : null}
      <BotItemsSettingsGroup bot={bot} update={update} />
      {home ? <SoulAndMemoryGroup home={home} open={open} /> : null}
      <AccessGroup bot={bot} open={open} />
      <BotSharingGroup bot={bot} open={open} />
      <NotificationsGroup bot={bot} update={update} />
      <div>
        <Button
          variant="ghost-destructive"
          size="sm"
          disabled={controlsOff}
          onClick={() => void deleteBot().then((deleted) => deleted && onDeleted())}
        >
          <Trash2 />
          {t('bots.settingsView.deleteBot', 'Delete bot…')}
        </Button>
      </div>
    </>
  )
}
