// A bot page's Chats tab: search and New chat on top, then every chat as one folded row, its workers behind a chevron.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { startBotSession } from '@/lib/bot-catalog'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { callBotRpc } from '@/lib/bot-hosts'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import {
  botChatListView,
  botChatMoreMatchesNote,
  botChatTreeStepIsPartial,
  orderChatsTab
} from '../../../../shared/bots/bot-chat-tree-view'
import {
  createBotChatSearchHook,
  type BotChatSearchAsk
} from '../../../../shared/bots/use-bot-chat-search'
import type { BotChatSearchResult } from '../../../../shared/bots/bot-chat-search'
import { BotChatTreeGroup } from './BotChatTreeGroup'
import {
  BotUsageLimitStopsContext,
  indexUsageLimitStops,
  useBotUsageLimitStops
} from './use-bot-usage-limit-stops'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { startAndOpenBotChat } from './bot-session-open'
import { BotChatTreeWorkerRow } from './BotChatTreeWorkerRow'
import { BotChatPaging } from './BotChatRowControls'
import { botErrorMessage } from './bot-presentation'
import { useBotOwnChatTree } from './use-bot-chat-tree'
import { useBotForWorkspace } from './bot-workspace'
import { BotPanelHeader } from './BotPanelHeader'
import { useBotNeedsYouCount, useBotNow } from './use-bot-now'
import { updateBotReporting } from './bot-update-reporting'
import { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { BotChatsSkeleton } from './BotChatsSkeleton'

const useBotChatSearch = createBotChatSearchHook({ useCallback, useEffect, useMemo, useState })

const NOTE = 'px-2 pt-1 text-2xs text-muted-foreground'
const HEADING = 'px-2 pt-2.5 pb-1 text-xs font-medium text-muted-foreground'

/** Activity's header, for a bot whose server is down: it says why the tab's actions are off. */
function OfflineHeader({ bot }: { bot: Bot }): React.JSX.Element {
  const now = useBotNow(bot)
  const needsYou = useBotNeedsYouCount(bot, now)
  const picture = useBotPictureSetting(bot, (updates) => updateBotReporting(bot, updates))
  return (
    <BotPanelHeader bot={bot} now={{ needsYou, working: now.working }} picture={picture} offline />
  )
}

/** Why this bot's chats couldn't be listed. */
function ChatsReadNote({ retry }: { retry: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className={NOTE}>
      {t('bots.chats.readFailed', "Couldn't read this bot's chats.")}{' '}
      <Button variant="link" size="inlineText" onClick={retry}>
        {t('bots.chats.searchRetry', 'Try again')}
      </Button>
    </p>
  )
}

export default function BotChatsPanel(): React.JSX.Element | null {
  const workspaceId = useAppStore((s) => s.activeWorktreeId)
  const bot = useBotForWorkspace(workspaceId)
  return bot ? <BotChatsTab key={bot.id} bot={bot} /> : null
}

function BotChatsTab({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const tree = useBotOwnChatTree(bot)
  // Its server is down: the last read shows with its actions off until it's back.
  const offline = useBotHostOffline(bot.hostId)
  const chats = useMemo(() => orderChatsTab(tree.chats), [tree.chats])
  // Its home's chats and runs, and each listed worker's own workspace.
  const stopWorkspaces = useMemo(
    () => [
      folderWorkspaceKey(bot.folderWorkspaceId),
      ...new Set(
        chats.flatMap((chat) =>
          [...chat.running, ...chat.finished].flatMap((worker) =>
            worker.worktreeId ? [worker.worktreeId] : []
          )
        )
      )
    ],
    [bot.folderWorkspaceId, chats]
  )
  const stops = useBotUsageLimitStops(bot, stopWorkspaces)
  const stopIndex = useMemo(() => indexUsageLimitStops(stops), [stops])
  const [steps, setSteps] = useState(0)
  const [query, setQuery] = useState('')
  // The panel's own folds, apart from the sidebar's: every chat starts folded here.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set())
  const fold = (chatId: string, open: boolean): void =>
    setUnfolded((current) => {
      const next = new Set(current)
      if (open) {
        next.add(chatId)
      } else {
        next.delete(chatId)
      }
      return next
    })
  const { hostId, id: botId } = bot
  const ask = useCallback<BotChatSearchAsk>(
    (text) =>
      callBotRpc<BotChatSearchResult>({ hostId }, 'bots.chats.search', {
        botId,
        query: text
      }).catch((error: unknown) => {
        console.error('Failed to search bot chats:', error)
        throw error
      }),
    [hostId, botId]
  )
  const search = useBotChatSearch(ask, chats, query)
  const { found, older, onlyHome, noMatch, searchFailed, moreMatches } = botChatListView(chats, {
    steps,
    query,
    search
  })
  const searching = query.trim() !== ''
  // A search lists the chats it found by their own words, then the workers it found by title.
  const chatHits = found.filter((hit) => hit.matches === null)
  const workerHits = found.flatMap(({ chat, matches }) =>
    matches
      ? [...chat.running, ...chat.finished]
          .filter((worker) => matches.has(worker.key))
          .map((worker) => ({ chat, worker }))
      : []
  )
  const newChat = (): void => {
    startAndOpenBotChat(
      bot,
      () => startBotSession(bot, { agent: bot.agent }),
      (error) => toast.error(botErrorMessage(error))
    )
  }
  const newChatLabel = t('bots.chats.new', 'New chat')
  return (
    <BotUsageLimitStopsContext.Provider value={stopIndex}>
      <div
        tabIndex={-1}
        className="@container scrollbar-sleek flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-2.5 pb-3 outline-none"
      >
        {/* Outside the fieldset, so its settings open offline too and say what's unavailable. */}
        {offline ? <OfflineHeader bot={bot} /> : null}
        <fieldset disabled={offline} className="contents">
          <div className="flex items-center gap-1.5 px-0.5 pb-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('bots.chats.search', 'Search chats and workers')}
                aria-label={t('bots.chats.search', 'Search chats and workers')}
                density="compact"
                inset="leadingIcon"
              />
            </div>
            <Button
              variant="outline"
              size="xs"
              className="h-7"
              aria-label={newChatLabel}
              onClick={newChat}
            >
              <Plus />
              <span className="@max-[240px]:hidden">{newChatLabel}</span>
            </Button>
          </div>
          {chats.length === 0 && tree.state !== 'ready' ? (
            tree.state === 'loading' ? (
              <BotChatsSkeleton />
            ) : (
              <ChatsReadNote retry={tree.retry} />
            )
          ) : null}
          {searching && chatHits.length > 0 ? (
            <div className={HEADING}>{t('bots.chats.title', 'Chats')}</div>
          ) : null}
          {chatHits.map(({ chat }) => (
            <BotChatTreeGroup
              key={chat.chatId}
              bot={bot}
              chat={chat}
              unfolded={searching ? null : unfolded.has(chat.chatId)}
              onFold={(open) => fold(chat.chatId, open)}
              loadMore={tree.loadMore}
            />
          ))}
          {workerHits.length > 0 ? (
            <>
              <div className={HEADING}>{t('bots.chats.workers', 'Workers')}</div>
              {workerHits.map(({ chat, worker }) => (
                <BotChatTreeWorkerRow
                  key={`${chat.chatId}:${worker.key}`}
                  bot={bot}
                  worker={worker}
                  chat={chat.title || t('bots.chats.untitled', 'New chat')}
                  showChat
                />
              ))}
            </>
          ) : null}
          {noMatch ? (
            <p className={NOTE}>{t('bots.chats.noMatch', 'No chats or workers match.')}</p>
          ) : null}
          {searchFailed ? (
            <p className={NOTE}>
              {t('bots.chats.searchFailed', "Couldn't search this bot's chats.")}{' '}
              <Button variant="link" size="inlineText" onClick={search?.retry}>
                {t('bots.chats.searchRetry', 'Try again')}
              </Button>
            </p>
          ) : null}
          {moreMatches > 0 ? (
            <p className={NOTE}>{botChatMoreMatchesNote(t, moreMatches)}</p>
          ) : null}
          {onlyHome ? (
            <p className={NOTE}>
              {t(
                'bots.chats.empty',
                'Side chats, Slack and Linear threads and automation runs show up here, each with the workers it starts.'
              )}
            </p>
          ) : null}
          <BotChatPaging
            more={
              older > 0
                ? [
                    {
                      label: botChatTreeStepIsPartial(older)
                        ? t('bots.chats.olderStep', 'Show 8 more · {{count}} older', {
                            count: older
                          })
                        : t('bots.chats.older', 'Show {{count}} older', { count: older }),
                      onClick: () => setSteps(steps + 1)
                    }
                  ]
                : []
            }
            onFewer={steps > 0 ? () => setSteps(0) : null}
            className="px-2 py-1 text-xs"
          />
        </fieldset>
      </div>
    </BotUsageLimitStopsContext.Provider>
  )
}
