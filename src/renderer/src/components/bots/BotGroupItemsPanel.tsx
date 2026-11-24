import React, { useEffect, useMemo, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { useNow } from '@/lib/window-activity/use-now'
import type { Bot } from '../../../../shared/bot-types'
import { botGroupSessionIds, type BotGroup } from '../../../../shared/bots/bot-group'
import { botGroupMemberBots } from '../../../../shared/bots/bot-sidebar-entries'
import { BOT_ITEM_GROUP_IDS, type BotItemFilter } from '../../../../shared/bots/bot-item-groups'
import type { BotItem } from '../../../../shared/bots/bot-items'
import { BotGroupPanelHeader } from './BotGroupPanelHeader'
import { BotItemsFilterButton, botItemChatName } from './items/BotItemsFilter'
import { renderBotGroupItemsAllClear } from './items/BotItemsAllClear'
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
import { useRightSidebarGutterResize } from '@/components/right-sidebar/layout/right-sidebar-gutter-resize'

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
  const [botIds, setBotIds] = useState<readonly string[] | null>(null)
  const [needsYouOnly, setNeedsYouOnly] = useState(false)
  const filter: BotItemFilter = useMemo(() => {
    // A member that left drops out of the filter.
    const shown = botIds?.filter((id) => members.some((bot) => bot.id === id)) ?? []
    return {
      chatIds: null,
      botIds: shown.length > 0 ? shown : null,
      needsYou: needsYouOnly
    }
  }, [botIds, members, needsYouOnly])
  const cleared: BotItemFilter = { chatIds: null, botIds: null, needsYou: false }
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const setFilter = (next: BotItemFilter): void => {
    setReturnTo(null)
    setBotIds(next.botIds)
    setNeedsYouOnly(next.needsYou)
  }
  const clock = useNow(60_000)
  const merged = useBotGroupItems(members, filter, clock)
  const facePictures = useBotGroupFacePictures()
  useEffect(() => facePictures.retain(members), [facePictures, members])
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
  const gutterResize = useRightSidebarGutterResize(scroll)
  const filteredBots = members.filter((bot) => filter.botIds?.includes(bot.id))
  const named = [
    ...(filteredBots.length > 0 ? [filteredBots.map((bot) => bot.name).join(', ')] : []),
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
  // Keep row placement stable until the group changes.
  const { placeOf, placed } = useMemo(() => {
    const groupIds = new Set(botGroupSessionIds([group, ...(group.threads ?? [])]))
    // A chat filter shows only the group's own chats, so then no row names another.
    const outsideGroup = (item: BotItem): boolean => !groupIds.has(item.chat.id)
    return {
      placeOf: (item: BotItem): string | null =>
        outsideGroup(item) ? botItemChatName(item.chat, t) : null,
      placed: outsideGroup
    }
  }, [group, t])
  // Offline says so elsewhere; the line leads the folded sections rather than trailing them.
  const allClear =
    merged.ready &&
    rows &&
    !named &&
    !asking &&
    !merged.offline &&
    merged.list.groups.needs_you.length + merged.list.groups.working.length === 0
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
      return null
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
          data-bot-items-scroller=""
          tabIndex={-1}
          // The wider left padding is the sidebar's resize grab area, 4 px clear of every row.
          className="@container scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pl-3.5 pr-2 py-3 outline-none"
          {...gutterResize}
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
                  filter={filter}
                  onFilter={setFilter}
                  group={{
                    bots: members.map((bot) => ({
                      bot,
                      count: merged.openCounts.get(bot.id) ?? 0
                    })),
                    cleared,
                    named: named || null
                  }}
                />
              ) : null
            }
          />
          <fieldset disabled={merged.offline} className="contents">
            {/* A member's kept rows show while its refresh failed: say so above them, with Retry. */}
            {merged.ready && merged.failedRetry ? (
              <BotItemsReadFailed stale onRetry={merged.failedRetry} />
            ) : null}
            <BotItemsList
              allClear={allClear ? renderBotGroupItemsAllClear(members) : null}
              bot={{
                foldKey: `group:${group.id}`,
                botOf: merged.botOf,
                seenOf: merged.seenOf,
                needBot: merged.needBot,
                placeOf,
                placed
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
