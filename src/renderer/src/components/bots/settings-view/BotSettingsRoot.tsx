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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAccessRequests } from '@/lib/bot-access-requests'
import { useAppStore } from '@/store'
import { nativeChatPermissionModeLabel } from '@/components/native-chat/session/options/controls/native-chat-permission-mode-labels'
import {
  agentChatPermissionModes,
  chatAsksNoApprovals,
  savedChatPermissionMode
} from '../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import { botMembersFrom, type Bot } from '../../../../../shared/bot-types'
import { botLookAround, lookAroundSupported } from '../../../../../shared/bots/bot-look-around'
import { botTidyUp } from '../../../../../shared/bots/bot-tidy-up'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { BotHome } from '../../settings/bots/bot-home-files'
import { useBotMemoryTopicCount } from '../../settings/bots/use-bot-memory-topics'
import { useBotNotificationToggles } from '../../settings/bots/use-bot-notification-toggles'
import { botSkillSourceNames, useBotOwnSkills } from '../../settings/bots/use-bot-skill-projects'
import { useBotPictureSetting } from '../../settings/bots/use-bot-picture-setting'
import { BotNameInlineEdit } from '../BotNameInlineEdit'
import { BotPictureButton } from '../BotPictureButton'
import { ACCOUNT_CONNECTORS, useBotConnectorState } from '../bot-connectors'
import { botAgentLabel } from '../bot-presentation'
import {
  countValue,
  lookAroundValue,
  memoryValue,
  tidyUpValue,
  whoCanAskValue
} from '../bot-settings-row-states'
import { useBotTools } from '../bot-tool-checks'
import { useDeleteBot } from '../use-delete-bot'
import { BotShareFlow } from '../sharing/BotShareFlow'
import { BotSharedFromLine } from './BotSharedFromLine'
import { BotSharingGroup } from './BotSharingPage'
import { useBotComputerName } from './BotComputerPage'
import type { BotSettingsPage } from './bot-settings-place'
import { SettingsControlsOffContext, SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'
import { BotItemsSettingsGroup } from './BotItemsSettingsGroup'

type Update = (updates: BotUpdateParams['updates']) => Promise<Bot | null>

function BotSettingsSwitch(props: React.ComponentProps<typeof Switch>): React.JSX.Element {
  // Extend the pointer target into the row padding around the compact track.
  return <Switch {...props} size="compact" className="after:absolute after:-inset-2" />
}

function useAccessValues(bot: Bot): { connectors: string; whoCanAsk: string } {
  const state = useBotConnectorState(bot)
  const requests = useAccessRequests().filter(
    (request) => request.botId === bot.id && request.hostId === bot.hostId
  ).length
  const people = ACCOUNT_CONNECTORS.filter((connector) => connector.id !== 'google').reduce(
    (sum, connector) => sum + botMembersFrom(bot.members, connector.id).length,
    0
  )
  return {
    connectors: countValue(state.catalog.filter(state.added).length),
    whoCanAsk: whoCanAskValue(people, requests)
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
  const lookAroundTitle = t('settings.bots.lookAround.title', 'Look around')
  const tidyUpTitle = t('settings.bots.tidyUp.title', 'Memory upkeep')
  return (
    <SettingsInsetGroup title={t('bots.settingsView.schedule', 'Schedule')}>
      <SettingsInsetRow
        icon={<Eye />}
        title={lookAroundTitle}
        value={lookAroundValue(lookAround)}
        page="look-around"
        onOpen={() => open('look-around')}
        end={
          <BotSettingsSwitch
            checked={lookAround.on}
            aria-label={lookAroundTitle}
            onCheckedChange={() => void update({ lookAround: { on: !lookAround.on } })}
          />
        }
      />
      <SettingsInsetRow
        icon={<Moon />}
        title={tidyUpTitle}
        value={tidyUpValue(tidyUp)}
        page="tidy-up"
        onOpen={() => open('tidy-up')}
        end={
          <BotSettingsSwitch
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
  const topicFiles = useBotMemoryTopicCount(home)
  return (
    <SettingsInsetGroup title={t('bots.settingsView.soulAndMemory', 'Soul and memory')}>
      <SettingsInsetRow
        icon={<Smile />}
        title={t('settings.bots.soul', 'Soul')}
        page="soul"
        onOpen={() => open('soul')}
      />
      <SettingsInsetRow
        icon={<Brain />}
        title={t('settings.bots.memory', 'Memory')}
        value={memoryValue(topicFiles)}
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
  const values = useAccessValues(bot)
  const { view } = useBotTools(bot, 'finished')
  const repos = useAppStore((state) => state.repos)
  const own = useBotOwnSkills(bot)
  const skills = countValue(
    botSkillSourceNames(
      own,
      (bot.skillProjects ?? []).flatMap(
        (id) => repos.find((repo) => repo.id === id)?.displayName ?? []
      )
    ).length
  )
  return (
    <SettingsInsetGroup title={t('bots.settingsView.access', 'Access')}>
      <SettingsInsetRow
        icon={<Plug />}
        title={t('settings.bots.connectors', 'Connectors')}
        value={values.connectors}
        page="connectors"
        onOpen={() => open('connectors')}
      />
      <SettingsInsetRow
        icon={<Users />}
        title={t('bots.settingsView.whoCanAsk', 'Who can ask')}
        value={values.whoCanAsk}
        page="who-can-ask"
        onOpen={() => open('who-can-ask')}
      />
      <SettingsInsetRow
        icon={<Wrench />}
        title={t('settings.bots.tools.title', 'Tools')}
        value={
          view.status === 'ready'
            ? countValue(view.tools.own.length + view.tools.inherited.length)
            : null
        }
        page="tools"
        onOpen={() => open('tools')}
      />
      <SettingsInsetRow
        icon={<BookOpen />}
        title={t('settings.bots.skills.title', 'Skills')}
        value={skills}
        page="skills"
        onOpen={() => open('skills')}
      />
    </SettingsInsetGroup>
  )
}

function NotificationsGroup({ bot, update }: { bot: Bot; update: Update }): React.JSX.Element {
  const t = useTranslate()
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  const notificationsMuted = useAppStore(
    (s) => s.notificationsMutedByWorktree?.[workspaceId] === true
  )
  const toggleWorktreeNotificationsMuted = useAppStore((s) => s.toggleWorktreeNotificationsMuted)
  const muteLabel = t('settings.bots.muteNotifications', 'Mute notifications')
  return (
    <SettingsInsetGroup title={t('settings.bots.notifications', 'Notifications')}>
      <SettingsInsetRow
        title={muteLabel}
        detail={t(
          'settings.bots.muteNotificationsDescription',
          'Stop sending system notifications. Unread indicators still appear.'
        )}
        wrapDetail
        end={
          <BotSettingsSwitch
            checked={notificationsMuted}
            aria-label={muteLabel}
            onCheckedChange={() => toggleWorktreeNotificationsMuted(workspaceId)}
          />
        }
      />
      {useBotNotificationToggles(bot).map((toggle) => (
        <SettingsInsetRow
          key={toggle.key}
          title={toggle.label}
          end={
            <BotSettingsSwitch
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
  const shareLabel = t('bots.settingsView.shareAction', 'Share')
  const [sharing, setSharing] = useState(false)
  const picture = useBotPictureSetting(bot, update)
  return (
    <>
      {sharing ? <BotShareFlow bot={bot} onClose={() => setSharing(false)} /> : null}
      <div className="rounded-[10px] bg-foreground/[0.035] p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <fieldset disabled={controlsOff} className="contents">
            <BotPictureButton
              bot={bot}
              picture={picture}
              avatarClassName="size-8 rounded-lg text-sm"
              className="rounded-lg"
            />
          </fieldset>
          <div className="min-w-0 flex-1">
            <fieldset disabled={controlsOff} className="contents">
              <BotNameInlineEdit
                bot={bot}
                update={update}
                className="text-sm font-semibold leading-5"
              />
            </fieldset>
            <BotSharedFromLine bot={bot} />
          </div>
          <div data-slot="bot-settings-actions" className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              {/* The span keeps the tooltip on hover while the button is off (its host is offline). */}
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    variant="muted-field-icon"
                    size="icon-sm"
                    className="size-7"
                    aria-label={shareLabel}
                    disabled={controlsOff}
                    onClick={() => setSharing(true)}
                  >
                    <Share2 className="size-3.5" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{shareLabel}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      <SettingsInsetGroup title={t('settings.bots.agent', 'Agent')}>
        <SettingsInsetRow
          icon={<BotIcon />}
          title={t('settings.bots.agent', 'Agent')}
          value={botAgentLabel(bot.agent)}
          page="agent"
          onOpen={() => open('agent')}
        />
        <SettingsInsetRow
          icon={<Shield />}
          title={t('settings.bots.permissions', 'Permissions')}
          value={permissionLine(bot, t)}
          page="permissions"
          onOpen={() => open('permissions')}
        />
        <SettingsInsetRow
          icon={bot.hostId === 'local' ? <Laptop /> : <Server />}
          title={t('bots.settingsView.computer', 'Computer')}
          value={computer}
          page="computer"
          onOpen={() => open('computer')}
        />
        <SettingsInsetRow
          icon={<Activity />}
          title={t('settings.bots.active', 'Active')}
          end={
            <BotSettingsSwitch
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
