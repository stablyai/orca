import React, { useMemo, useSyncExternalStore } from 'react'
import { Bot as BotIcon, UserPlus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { readBots, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import {
  reviewAccessRequest,
  useAccessRequests,
  type HostAccessRequest
} from '@/lib/bot-access-requests'
import { BotAvatar } from '@/components/bots/BotAvatar'
import { openBotHomePanelFromSidebar } from '@/components/bots/BotRow'
import { isLiveAccessRequest, readActivityInboxBots, type ActivityInboxBot } from './activity-inbox'
import { ActivityInboxRow } from './ActivityInboxRow'

const noop = (): void => {}

// A primitive key, so the external-store snapshot is stable between notifications.
function readBotsNeedingYouKey(): string {
  return readActivityInboxBots()
    .map(({ bot, count }) => `${bot.hostId}\u0000${bot.id}\u0000${count}`)
    .join('\u0001')
}

export type ActivityInboxBotEntries = {
  bots: ActivityInboxBot[]
  requests: HostAccessRequest[]
}

/** Bots with tasks needing you and pending access requests, from what the renderer already holds (no fetch). */
export function useActivityInboxBotEntries(): ActivityInboxBotEntries {
  const botsKey = useSyncExternalStore(subscribeToBotChanges, readBotsNeedingYouKey)
  // botsKey changes exactly when the rows do; the read itself is the snapshot's in-memory lists.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const bots = useMemo(() => readActivityInboxBots(), [botsKey])
  const allRequests = useAccessRequests()
  const requests = useMemo(() => allRequests.filter(isLiveAccessRequest), [allRequests])
  return { bots, requests }
}

/** Each bot row opens the bot's Home with its Needs you; each access row opens its review. */
export function ActivityInboxBotRows({
  bots,
  requests
}: ActivityInboxBotEntries): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {bots.map(({ bot, count }) => (
        <ActivityInboxRow
          key={`${bot.hostId}:${bot.id}`}
          avatar={<BotAvatar bot={bot} className="size-4 rounded-full" />}
          title={bot.name}
          line={
            count === 1
              ? t('activityInbox.botTask', '1 task needs you')
              : t('activityInbox.botTasks', '{{count}} tasks need you', { count })
          }
          ask
          contextIcon={<BotIcon className="size-3" aria-hidden />}
          context={t('activityInbox.opensNeedsYou', 'Opens its Needs you')}
          onOpen={() => openBotHomePanelFromSidebar(bot, noop)}
        />
      ))}
      {requests.map((request) => {
        const bot = readBots().find(
          (candidate) => candidate.id === request.botId && candidate.hostId === request.hostId
        )
        return (
          <ActivityInboxRow
            key={`${request.hostId}:${request.requestId}`}
            avatar={
              bot ? (
                <BotAvatar bot={bot} className="size-4 rounded-full" />
              ) : (
                <BotIcon className="size-3.5 text-muted-foreground" aria-hidden />
              )
            }
            title={bot?.name ?? request.requester.name}
            line={t('activityInbox.accessRequest', '{{name}} asked for access', {
              name: request.requester.name
            })}
            ask
            contextIcon={<UserPlus className="size-3" aria-hidden />}
            context={t('activityInbox.accessContext', 'Access request · {{source}}', {
              source: request.source === 'slack' ? 'Slack' : 'Linear'
            })}
            onOpen={() => reviewAccessRequest(request)}
          />
        )
      })}
    </>
  )
}
