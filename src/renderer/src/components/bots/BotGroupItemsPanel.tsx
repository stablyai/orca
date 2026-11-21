// A group's Items tab: its header, then its members' items as one list, scoped to the group's rooms by
// default. Rows open their own bot's item here; the list only reads, so the members' seen marks stay.
import React, { useEffect, useMemo, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { botRefKey } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import { useNow } from '@/lib/window-activity/use-now'
import type { Bot } from '../../../../shared/bot-types'
import { botGroupSessionIds, type BotGroup } from '../../../../shared/bots/bot-group'
import { botGroupMemberBots } from '../../../../shared/bots/bot-sidebar-entries'
import { BOT_ITEM_GROUP_IDS, type BotItemFilter } from '../../../../shared/bots/bot-item-groups'
import type { BotItem } from '../../../../shared/bots/bot-items'
import { BotGroupPanelHeader } from './BotGroupPanelHeader'
import {
  BotItemsFilterButton,
  botItemChatName,
  sameChats,
  type BotItemFilterScope
} from './items/BotItemsFilter'
import { BotItemsList } from './items/BotItemsList'
import {
  BotGroupFacePicturesContext,
  useBotGroupFacePictures
} from './items/bot-group-face-pictures'
import { BotItemsLoading } from './items/BotItemsLoading'
import { BotItemsReadFailed } from './items/BotItemsReadFailed'
import { BotItemPane } from './items/BotItemPane'
import { botItemWalkReturnRow } from '../../../../shared/bots/bot-item-walk'
import { useBotItemWalk } from './items/use-bot-item-walk'
import { useBotGroupItems } from './use-bot-group-items'

const GROUP_SCOPE = 'group'
const ALL_SCOPE = 'all'

function groupScopes(group: BotGroup, t: Translate): BotItemFilterScope[] {
  const threads = group.threads ?? []
  return [
    {
      key: GROUP_SCOPE,
      name: t('bots.groups.items.thisGroup', 'This group'),
      icon: 'group',
      chatIds: botGroupSessionIds([group, ...threads])
    },
    // A group without threads has one room, which This group already is.
    ...(threads.length > 0
      ? [
          { key: group.id, name: group.name, icon: null, chatIds: botGroupSessionIds([group]) },
          ...threads.map((thread) => ({
            key: thread.id,
            name: thread.title ?? t('bots.groups.items.thread', 'Thread'),
            icon: null,
            chatIds: botGroupSessionIds([thread])
          }))
        ]
      : []),
    {
      key: ALL_SCOPE,
      name: t('bots.groups.items.all', 'All their work'),
      icon: 'all',
      chatIds: null
    }
  ]
}

/** "Ana", "Ana or Bo", "Ana, Bo or Cy". */
function botNames(bots: readonly Bot[], t: Translate): string {
  const names = bots.map((bot) => bot.name)
  const last = names.pop()
  return names.length === 0
    ? (last ?? '')
    : t('bots.groups.items.orNames', '{{names}} or {{last}}', { names: names.join(', '), last })
}

export function BotGroupItemsPanel({ group }: { group: BotGroup }): React.JSX.Element {
  const t = useTranslate()
  const bots = useBots()
  const members = useMemo(() => botGroupMemberBots(group, bots), [group, bots])
  const scopes = useMemo(() => groupScopes(group, t), [group, t])
  const [scopeKey, setScopeKey] = useState(GROUP_SCOPE)
  const [botIds, setBotIds] = useState<readonly string[] | null>(null)
  const [needsYouOnly, setNeedsYouOnly] = useState(false)
  // A room or thread gone since it was picked falls back to the whole group.
  const scope = scopes.find((entry) => entry.key === scopeKey) ?? scopes[0]!
  const filter: BotItemFilter = useMemo(() => {
    // A member that left drops out of the filter.
    const shown = botIds?.filter((id) => members.some((bot) => bot.id === id)) ?? []
    return {
      chatIds: scope.chatIds,
      botIds: shown.length > 0 ? shown : null,
      needsYou: needsYouOnly
    }
  }, [scope.chatIds, botIds, members, needsYouOnly])
  const cleared: BotItemFilter = { chatIds: scopes[0]!.chatIds, botIds: null, needsYou: false }
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const setFilter = (next: BotItemFilter): void => {
    setReturnTo(null)
    setScopeKey(scopes.find((entry) => sameChats(entry.chatIds, next.chatIds))?.key ?? GROUP_SCOPE)
    setBotIds(next.botIds)
    setNeedsYouOnly(next.needsYou)
  }
  const clock = useNow(60_000)
  const merged = useBotGroupItems(members, filter, clock)
  const facePictures = useBotGroupFacePictures()
  useEffect(
    () =>
      facePictures.retain(
        new Map(
          members.map((bot) => {
            const avatar = parseBotAvatar(bot.avatar)
            return [botRefKey(bot), avatar?.kind === 'upload' ? avatar.version : null]
          })
        )
      ),
    [facePictures, members]
  )
  const walk = useBotItemWalk(merged.list, `group:${group.id}`)
  const openItem = (uid: string): void => {
    setReturnTo(null)
    walk.open(uid)
  }
  const back = (): void => {
    facePictures.retryFailed()
    const left = walk.close()
    const listed = BOT_ITEM_GROUP_IDS.flatMap((id) =>
      merged.list.groups[id].map((item) => item.uid)
    )
    setReturnTo(left ? botItemWalkReturnRow(left.walk, left.uid, listed) : null)
  }
  const scroll = React.useRef<HTMLDivElement | null>(null)
  const filteredBots = members.filter((bot) => filter.botIds?.includes(bot.id))
  const named = [
    ...(filteredBots.length > 0 ? [filteredBots.map((bot) => bot.name).join(', ')] : []),
    ...(scope.key !== GROUP_SCOPE ? [scope.name] : []),
    ...(filter.needsYou ? [t('bots.items.filter.needsYou', 'Needs you only')] : [])
  ].join(' · ')
  const openBot = walk.uid ? merged.botOfUid(walk.uid) : null
  // An item no member read holds once every read has landed (a Closed page's, reopened after the
  // panel remounted): back to the list rather than a list under a stale open item.
  const { uid: openUid, close: closeItem } = walk
  const unowned = openUid !== null && openBot === null && merged.ready
  useEffect(() => {
    if (unowned) {
      closeItem()
    }
  }, [unowned, closeItem])
  const asking = merged.needs.length + merged.stoppedForSignIn.length > 0
  const rows = merged.shown.length > 0 || asking
  // Stable while the scope is, so the list's row heights aren't recomputed on every render.
  const filterChatIds = filter.chatIds
  const { placeOf, placed } = useMemo(() => {
    const groupIds = new Set(scopes[0]!.chatIds)
    // A chat filter shows only the group's own chats, so then no row names another.
    const outsideGroup =
      filterChatIds === null ? (item: BotItem): boolean => !groupIds.has(item.chat.id) : null
    return {
      placeOf: (item: BotItem): string | null =>
        outsideGroup?.(item) ? botItemChatName(item.chat, t) : null,
      placed: outsideGroup
    }
  }, [scopes, filterChatIds, t])
  const note = (): React.ReactNode => {
    if (members.length === 0) {
      return null
    }
    if (merged.failedRetry && !merged.ready) {
      return <BotItemsReadFailed onRetry={merged.failedRetry} />
    }
    if (!merged.ready) {
      return rows ? null : <BotItemsLoading />
    }
    if (rows) {
      return named ||
        asking ||
        merged.list.groups.needs_you.length + merged.list.groups.working.length > 0 ? null : (
        <p className="px-6 py-6 text-center text-xs text-muted-foreground">
          {t('bots.items.empty.allClear', 'Nothing needs you and nothing is running.')}
        </p>
      )
    }
    if (named) {
      return (
        <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-xs text-muted-foreground">
          <ListChecks className="size-5" />
          <b className="text-[13px] font-medium text-foreground">
            {filteredBots.length > 0
              ? filter.needsYou
                ? t('bots.groups.items.emptyBotsNeedsYou', 'Nothing from {{names}} needs you', {
                    names: botNames(filteredBots, t)
                  })
                : t('bots.groups.items.emptyBots', 'No items from {{names}}', {
                    names: botNames(filteredBots, t)
                  })
              : filter.needsYou
                ? t('bots.items.empty.needsYou', 'Nothing needs you.')
                : t('bots.items.empty.filtered', 'No items match.')}
          </b>
          <Button variant="outline" size="xs" onClick={() => setFilter(cleared)}>
            {t('bots.items.filter.clearAll', 'Clear filters')}
          </Button>
        </div>
      )
    }
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-xs text-muted-foreground">
        <ListChecks className="size-5" />
        <b className="text-[13px] font-medium text-foreground">
          {t('bots.groups.items.emptyTitle', 'No items from this group yet')}
        </b>
        {t(
          'bots.groups.items.emptyBody',
          'When {{names}} take something on in this group, it shows up here.',
          { names: botNames(members, t) }
        )}
        <Button variant="outline" size="xs" onClick={() => setFilter({ ...filter, chatIds: null })}>
          {t('bots.groups.items.showAll', 'Show all their work')}
        </Button>
      </div>
    )
  }
  // The readers stay mounted in one place across list and item: the item's walk and bot come from them.
  return (
    <BotGroupFacePicturesContext.Provider value={facePictures}>
      {merged.readers}
      {walk.uid && openBot ? (
        <BotItemPane
          bot={openBot}
          uid={walk.uid}
          listed={merged.shown.find((item) => item.uid === walk.uid)}
          walk={walk}
          offline={merged.offline}
          onBack={back}
          named
        />
      ) : (
        <div
          ref={scroll}
          data-bot-items-scroller=""
          tabIndex={-1}
          className="@container scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-2 py-3 outline-none"
        >
          <BotGroupPanelHeader
            group={group}
            members={members}
            needsYou={merged.needsYou}
            working={merged.working}
            next={merged.next}
            now={clock}
            filter={
              members.length > 0 ? (
                <BotItemsFilterButton
                  items={merged.shown}
                  chats={[]}
                  filter={filter}
                  onFilter={setFilter}
                  group={{
                    bots: members.map((bot) => ({
                      bot,
                      count: merged.openCounts.get(bot.id) ?? 0
                    })),
                    scopes,
                    cleared,
                    named: named || null
                  }}
                />
              ) : null
            }
          />
          <fieldset disabled={merged.offline} className="contents">
            <BotItemsList
              bot={{
                foldKey: `group:${group.id}`,
                botOf: merged.botOf,
                seenOf: merged.seenOf,
                needBot: merged.needBot,
                placeOf,
                placed,
                outside: {
                  count: merged.outside,
                  of:
                    scope.key === GROUP_SCOPE ? 'group' : scope.key === group.id ? 'room' : 'thread'
                }
              }}
              groups={merged.list.groups}
              seenEventId=""
              closedTotal={merged.list.closedTotal}
              onMoreClosed={merged.list.loadMoreClosed}
              staleDays={null}
              now={clock}
              focusUid={returnTo}
              onOpen={(item) => openItem(item.uid)}
              asks={{
                needs: merged.needs,
                stoppedForSignIn: merged.stoppedForSignIn,
                itemOf: merged.itemOf
              }}
              offline={merged.offline}
              focusFallback={scroll}
              scroller={scroll}
            />
            {note()}
          </fieldset>
        </div>
      )}
    </BotGroupFacePicturesContext.Provider>
  )
}
