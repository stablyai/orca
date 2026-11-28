import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { botTarget } from '@/lib/bot-hosts'
import { buildWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-agent-rows'
import { selectLiveAgentStatusEntriesForWorktree } from '@/components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import { useNow } from '@/lib/window-activity/use-now'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { useBotWaits, useListedBotItemsNeedingOwner } from '@/lib/bot-catalog'
import { usePublishedBotNeedsYou } from './bot-needs-you-published'
import { useStructuredAgentSessionsStarting } from '@/components/native-chat/session/status/structured-agent-session-status-hooks'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { stripInlineMarkdownForToc } from '@/components/editor/markdown/navigation/markdown-toc-text'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { chatPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Bot } from '../../../../shared/bot-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { formatWaitTime } from './bot-wait-copy'
import { CONNECTOR_SOURCE_ICONS } from '../native-chat/NativeChatConnectorAskerTag'
import { selectBotRowLine, type BotRowLine, type BotRowPlace } from './bot-row-activity-line'
import { botRowLineText, botRowReplyingAt } from '../../../../shared/bots/bot-row-line'
import { countLiveBotWorkspaces } from '../../../../shared/bots/bot-sidebar-workspaces'
import { useBotWorkerWorkspaces, useLiveWorkspaceStatuses } from './use-bot-worker-statuses'
import { useBotOwnChats } from '@/lib/bot-own-chats'
import {
  botRowLimit,
  usageLimitStopText,
  type BotRowLimit
} from '../../../../shared/bots/bot-usage-limit-stop'
import { useBotUsageLimitStops } from './use-bot-usage-limit-stops'
import { formatUsageLimitResetShort } from '../../../../shared/agent-session/failures/agent-session-usage-limit'

const NO_LINKS: NonNullable<FolderWorkspace['externalConversations']> = []
const NO_ENTRIES: AgentStatusEntry[] = []

/** What the bot row's second line says, if anything. `needsYou`, where the caller reads the bot's
 *  Needs you count, is the count the line falls back to. */
export function useBotRowLine(
  bot: Bot,
  home: FolderWorkspace,
  needsYou?: number
): { line: BotRowLine | null; limit: BotRowLimit | null; now: number; needsYou: boolean } {
  const t = useTranslate()
  const links = home.externalConversations ?? NO_LINKS
  const chats = useBotOwnChats(bot.paused ? null : bot)
  const paneKeys = useMemo(
    () =>
      bot.paused
        ? []
        : [
            ...(bot.chatSessionId ? [chatPaneKey(bot.chatSessionId)] : []),
            ...links.map((link) => link.paneKey),
            ...(chats ?? []).map((chat) => chat.paneKey)
          ],
    [bot.paused, bot.chatSessionId, links, chats]
  )
  // Its chats' and threads' own status rows: a settled chat has no tab, so the home's row list drops it.
  const ownEntries = useAppStore(
    useShallow((state) =>
      paneKeys.flatMap((paneKey) => {
        const entry = state.agentStatusByPaneKey.get(paneKey)
        return entry ? [entry] : []
      })
    )
  )
  // The rest of its home's open sessions (runs, Look around), which count only as needing you or working.
  const homeEntries = useAppStore((state) =>
    bot.paused
      ? NO_ENTRIES
      : selectLiveAgentStatusEntriesForWorktree(state, folderWorkspaceKey(home.id))
  )
  const entries = useMemo(() => {
    const own = new Set(ownEntries.map((entry) => entry.paneKey))
    return [...ownEntries, ...homeEntries.filter((entry) => !own.has(entry.paneKey))]
  }, [ownEntries, homeEntries])
  const sessionIds = useMemo(
    () =>
      bot.paused
        ? []
        : [...(bot.chatSessionId ? [bot.chatSessionId] : []), ...links.map((l) => l.sessionId)],
    [bot.paused, bot.chatSessionId, links]
  )
  const startingSessionIds = useStructuredAgentSessionsStarting(sessionIds, botTarget(bot))
  const waits = useBotWaits(bot)
  const { childWorktrees } = useBotWorkerWorkspaces(home)
  const workerIds = useMemo(
    () => (bot.paused ? [] : childWorktrees.map((worktree) => worktree.id)),
    [bot.paused, childWorktrees]
  )
  const workerStatuses = useLiveWorkspaceStatuses(workerIds)
  const stopWorkspaces = useMemo(
    () => (bot.paused ? [] : [folderWorkspaceKey(home.id), ...workerIds]),
    [bot.paused, home.id, workerIds]
  )
  const [stop] = useBotUsageLimitStops(bot, stopWorkspaces)
  const workers = useMemo(() => countLiveBotWorkspaces(workerStatuses), [workerStatuses])
  const now = useNow(60_000)
  const rows = useMemo(() => buildWorktreeAgentRows({ tabs: [], entries, now }), [entries, now])
  // Its home's own status also reads terminal pane titles, which `rows` (built without tabs) misses.
  const homeStatus = useWorktreeActivityStatus(folderWorkspaceKey(home.id))
  // The panel, tab badge or toggle's count when one is mounted for the bot; else the rows' own asks
  // plus the items its host's list counted. Neither starts a read.
  const published = usePublishedBotNeedsYou(bot)
  const listedItems = useListedBotItemsNeedingOwner(bot)
  // Any of its own rows or workers working or waiting: the line is theirs, not the stop's.
  const busy = useMemo(
    () =>
      homeStatus === 'working' ||
      homeStatus === 'permission' ||
      workers.working > 0 ||
      workers.permission > 0 ||
      rows.some(
        (row) =>
          row.rowSource !== 'subagent' &&
          (row.state === 'working' || row.state === 'blocked' || row.state === 'waiting')
      ),
    [homeStatus, rows, workers]
  )
  const hasNeedsYou = useMemo(
    () =>
      !bot.paused &&
      (workers.permission > 0 ||
        rows.some(
          (row) =>
            row.rowSource !== 'subagent' && (row.state === 'blocked' || row.state === 'waiting')
        )),
    [bot.paused, rows, workers.permission]
  )
  const line = selectBotRowLine(
    {
      paused: bot.paused,
      startingSessionIds,
      rows,
      chatSessionId: bot.chatSessionId,
      links,
      chats,
      waits,
      workers,
      needsYou: needsYou ?? published ?? undefined,
      itemsNeedingYou: listedItems ?? undefined,
      now
    },
    t
  )
  const limit = botRowLimit(stop, line, busy, bot.chatSessionId, t)
  return { line, limit, now, needsYou: hasNeedsYou }
}

/** How long ago the line's activity was, shown on the row's first line. */
export function botRowLineAge(line: BotRowLine | null, now: number): string | null {
  return line?.kind === 'activity' && line.at !== null ? formatShortTimeAgo(line.at, now) : null
}

/** The second line: its text truncates first, the trailing control stays. */
export function BotRowLineView({
  line,
  limit = null,
  fallback = null,
  unread,
  now,
  disconnected = false,
  leading = null,
  trailing = null
}: {
  line: BotRowLine | null
  /** Said in place of a quiet line. */
  limit?: BotRowLimit | null
  /** Shown when there is no line: the bot's purpose, so the row has no blank line. */
  fallback?: string | null
  unread: boolean
  now: number
  /** Its server is down, so the line says so in place of its last activity. */
  disconnected?: boolean
  /** Before the text: a paired server's host pill, as a remote workspace's second line has. */
  leading?: React.ReactNode
  trailing?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
      {leading}
      {limit && !disconnected ? (
        // Amber like the badge; the badge's tooltip says whose limit and if it continues.
        <span className="min-w-0 flex-1 truncate text-status-warning-text tabular-nums">
          {t('bots.usageLimit.rowLine', 'Usage limit · {{time}}', {
            time: formatUsageLimitResetShort(limit.stop.at, now, intlLocale)
          })}
        </span>
      ) : (
        // No title: the row's hover card shows the whole line.
        <span className={cn('min-w-0 flex-1 truncate', unread && 'text-foreground')}>
          <BotRowLineText
            line={line}
            limit={limit}
            fallback={fallback}
            now={now}
            disconnected={disconnected}
          />
        </span>
      )}
      {trailing}
    </div>
  )
}

/** The line's words, with a place's label and icon, for a container that truncates them. */
export function BotRowLineText({
  line,
  limit = null,
  fallback = null,
  now,
  disconnected = false
}: {
  line: BotRowLine | null
  limit?: BotRowLimit | null
  /** Shown when there is no line: the bot's purpose. */
  fallback?: string | null
  now: number
  disconnected?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  if (disconnected) {
    return <>{t('bots.row.disconnected', 'Disconnected')}</>
  }
  if (limit) {
    return (
      <>
        {limit.place ? (
          <>
            <span className="font-medium text-foreground">{limit.place}</span>
            {' · '}
          </>
        ) : null}
        {usageLimitStopText(t, limit.stop)}
      </>
    )
  }
  if (line?.kind === 'activity' && line.place) {
    return (
      <>
        <BotRowPlaceLabel place={line.place} />
        {' · '}
        {line.text}
      </>
    )
  }
  if (line?.kind === 'replying' && line.place) {
    return <ReplyingAtLabel place={line.place} />
  }
  return <>{line ? lineText(t, line, now) : (fallback ?? '')}</>
}

/** The hover card's copy of the row's line, whole and with markdown stripped. */
export function BotHoverLatestLine({
  line,
  now
}: {
  line: BotRowLine | null
  now: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  if (!line || line.kind === 'paused') {
    return null
  }
  const age =
    line.kind === 'activity' && line.at !== null
      ? formatUiRelativeTime(line.at - now, intlLocale)
      : null
  // Block markers first (list bullets, headings, quotes), then inline links and emphasis.
  const text = stripInlineMarkdownForToc(
    lineText(t, line, now).replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/gm, '')
  )
  return (
    <div className="mt-2.5 line-clamp-3 border-t border-border pt-2 text-xs leading-snug text-foreground">
      {age ? <span className="text-muted-foreground">{age} · </span> : null}
      {text}
    </div>
  )
}

function BotRowPlaceLabel({ place }: { place: BotRowPlace }): React.JSX.Element {
  const SourceIcon = place.source ? CONNECTOR_SOURCE_ICONS[place.source] : undefined
  return (
    <span className="font-medium text-foreground">
      {SourceIcon ? <SourceIcon className="mr-1 inline-block size-3 align-[-2px]" /> : null}
      {place.label}
    </span>
  )
}

const PLACE_SLOT = '\u0000'

function ReplyingAtLabel({ place }: { place: BotRowPlace }): React.JSX.Element {
  const t = useTranslate()
  const [before = '', after = ''] = botRowReplyingAt(t, place, PLACE_SLOT).split(PLACE_SLOT)
  return (
    <>
      {before}
      <BotRowPlaceLabel place={place} />
      {after}
    </>
  )
}

// Takes the render's t, not module translate(): React Compiler memoizes this call on its arguments,
// so a module translate() here kept the previous language after a switch.
function lineText(t: Translate, line: BotRowLine, now: number): string {
  return botRowLineText(line, t, (by) => formatWaitTime(by, now))
}
