// An item's links as one quiet block: one line per link, its name left and its state right, the first
// five shown and the rest behind "N more". Every link opens on click or Enter: web links as the workspace
// card's linked PR does (the link setting's popover or browser), files in Orca's editor, only from the
// bot's folder, workers as the Chats tab opens them.
import { Square } from 'lucide-react'
import { useContext, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { useNativeChatLinkClick } from '@/components/native-chat/links/actions/native-chat-link-click-context'
import { hasGitHubLinkPeek } from '@/components/native-chat/links/previews/NativeChatGitHubLinkPeek'
import { NativeChatLinkPeek } from '@/components/native-chat/links/previews/NativeChatLinkPeek'
import {
  NativeChatLinkPeekContext,
  NativeChatLinkPeekProvider
} from '@/components/native-chat/links/previews/native-chat-link-peek-context'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getTaskPageGitHubWorkItemStateLabel } from '@/components/task-page/github/listing/task-page-github-work-item-status'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemLinkView, BotItemWorkerState } from '../../../../../shared/bots/bot-items'
import {
  botChatTreeWorkerOpen,
  botChatTreeWorkerRunning,
  WorkerStateIcon
} from '../BotChatTreeWorkerRow'
import { useBotGroupFileContexts } from '../BotGroupTranscriptOwner'
import { useWorkerStop, WorkerActivityDetails } from '../WorkerActivityRow'
import {
  botItemLinkRows,
  botItemWorkerRow,
  type BotItemGitHubRow,
  type BotItemLinkRow
} from '../../../../../shared/bots/bot-item-link-rows'
import { openBotItemFile, type BotItemFileContext } from './bot-item-file-open'
import {
  BotItemLinkRowButton,
  BotItemLinkRowMiddleTruncated,
  BotItemLinkRowName,
  BotItemLinkRowStatus,
  BotItemLinkRowStatusText,
  botItemLinkRowClassName
} from './BotItemLinkRow'
import {
  checksLabel,
  GITHUB_RETRY_KEY,
  useGitHubLinkPeekFallback
} from './bot-item-github-peek-content'
import { useBotItemLivePr, useBotItemPrWorkspacesVisible } from './use-bot-item-live-pr'
import { botItemLinksOrder } from './bot-item-links-order'
import { BOT_ITEM_PANE_CARD_MARGIN, botItemPaneBoundary } from './bot-item-pane-bounds'
import { usePeekBounds } from '@/components/native-chat/links/previews/use-peek-bounds'

/** Rows shown before "N more". */
export const BOT_ITEM_LINKS_SHOWN = 5

const noFolders: never[] = []

function Dot({ className }: { className: string }): React.JSX.Element {
  return <span aria-hidden className={cn('block size-1.5 shrink-0 rounded-full', className)} />
}

/** The item view's link handler: the workspace card's popover and destinations, from the bot's folder. A
 *  click it leaves alone (a plain click when the setting opens nothing) goes to the system browser, as the
 *  workspace card's link falls through to its anchor. */
function useOpenWeb(): (url: string, event: MouseEvent<HTMLElement>) => void {
  const onLinkClick = useNativeChatLinkClick()
  return (url, event) => {
    if (!onLinkClick) {
      openAppHttpLink(url, { event })
      return
    }
    onLinkClick(event, url)
    if (!event.defaultPrevented) {
      openAppHttpLink(url, { event, destination: 'system' })
    }
  }
}

/** CI where it can still change (open and draft PRs, once it has an outcome), else the PR's or issue's state. */
function gitHubStatus(t: Translate, row: BotItemGitHubRow): ReactNode {
  const live = row.type === 'pr' && (row.state === 'open' || row.state === 'draft')
  if (live && (row.checks === 'success' || row.checks === 'failure')) {
    return (
      <>
        <Dot className={row.checks === 'success' ? 'bg-status-success' : 'bg-destructive'} />
        {/* Short, so a row's state never truncates; the tip and card say "Checks …" in full. */}
        <BotItemLinkRowStatusText>
          {row.checks === 'success'
            ? t('bots.items.link.checksPassing', 'Passing')
            : t('bots.items.link.checksFailing', 'Failing')}
        </BotItemLinkRowStatusText>
      </>
    )
  }
  return row.state
    ? getTaskPageGitHubWorkItemStateLabel({ type: row.type, state: row.state }, t)
    : null
}

function GitHubRow({ row: hostRow }: { row: BotItemGitHubRow }): React.JSX.Element {
  const row = useBotItemLivePr(hostRow)
  const t = useTranslate()
  const openWeb = useOpenWeb()
  const card = hasGitHubLinkPeek(useContext(NativeChatLinkPeekContext), row.url)
  const number =
    row.type === 'pr'
      ? t('bots.items.link.pr', 'PR #{{number}}', { number: row.number })
      : t('bots.items.link.issue', 'Issue #{{number}}', { number: row.number })
  const tip = [
    row.title,
    `${row.repo}#${row.number}`,
    row.state
      ? getTaskPageGitHubWorkItemStateLabel({ type: row.type, state: row.state }, t)
      : t('bots.items.link.notRead', 'Not read yet'),
    checksLabel(t, row.checks)
  ]
    .filter(Boolean)
    .join(' · ')
  const name = row.title ?? number
  const fallback = useGitHubLinkPeekFallback(name, tip)
  const button = (
    <BotItemLinkRowButton
      name={<span className="min-w-0 truncate">{name}</span>}
      status={gitHubStatus(t, row)}
      tip={card ? undefined : tip}
      onClick={(event) => openWeb(row.url, event)}
    />
  )
  return card ? (
    <NativeChatLinkPeek
      href={row.url}
      side="bottom"
      githubFallback={fallback.pending}
      githubFailedFallback={fallback.failed}
      retryKey={GITHUB_RETRY_KEY}
      boundTo={botItemPaneBoundary}
      fullTitle
    >
      {button}
    </NativeChatLinkPeek>
  ) : (
    button
  )
}

/** A web link. A Linear issue reads as its key, with "Linear" for its state: nothing is borrowed from
 *  Orca's Linear cache, which can't yet prove that a cached title or state is this link's issue, read
 *  by a source this bot's pane may use. */
function WebRow({ row }: { row: Extract<BotItemLinkRow, { kind: 'web' }> }): React.JSX.Element {
  const t = useTranslate()
  const openWeb = useOpenWeb()
  return (
    <BotItemLinkRowButton
      name={
        row.linear ? (
          <span className="min-w-0 truncate">{row.title}</span>
        ) : (
          <BotItemLinkRowMiddleTruncated text={row.title} />
        )
      }
      status={row.linear ? t('bots.items.link.linear', 'Linear') : null}
      tip={row.linear ? `${row.title} · ${row.tip}` : row.url}
      onClick={(event) => openWeb(row.url, event)}
    />
  )
}

function workerStatusLabel(t: Translate, state: BotItemWorkerState): string {
  switch (state) {
    case 'working':
      return t('bots.items.link.running', 'Running')
    case 'completed':
    case 'missing':
      return t('bots.items.link.done', 'Done')
    case 'failed':
      return t('bots.items.link.failed', 'Failed')
    case 'stopped':
      return t('bots.items.link.stopped', 'Stopped')
    case 'unknown':
      return t('bots.chats.statusUnknown', 'Status unknown')
  }
}

/** A running worker with a dispatch can be stopped from its row. */
function workerCanStop(link: Extract<BotItemLinkRow, { kind: 'worker' }>['link']): boolean {
  const worker = botItemWorkerRow(link)
  return botChatTreeWorkerRunning(worker) && Boolean(worker.dispatchId)
}

/** A worker, as the Chats tab offers it: open on click, its details card on hover or focus, and Stop
 *  beside its state while it runs, shown on hover or once Tab reaches the row. */
function WorkerRow({
  bot,
  chat,
  link
}: {
  bot: Bot
  chat: string
  link: Extract<BotItemLinkRow, { kind: 'worker' }>['link']
}): React.JSX.Element {
  const t = useTranslate()
  const worker = botItemWorkerRow(link)
  const open = botChatTreeWorkerOpen(bot, worker)
  const canStop = workerCanStop(link)
  const state = workerStatusLabel(t, link.state)
  const { stopping, stop } = useWorkerStop(worker.dispatchId ?? '')
  const rowRef = useRef<HTMLDivElement | null>(null)
  const [cardOpen, setCardOpen] = useState(false)
  const bounds = usePeekBounds(cardOpen, rowRef, botItemPaneBoundary)
  return (
    <HoverCard openDelay={400} closeDelay={100} onOpenChange={setCardOpen}>
      <div ref={rowRef} className="group/worker flex min-w-0 items-center">
        <HoverCardTrigger asChild>
          <button type="button" disabled={!open} onClick={open} className={botItemLinkRowClassName}>
            <BotItemLinkRowName>
              <span className="min-w-0 truncate">{worker.title}</span>
            </BotItemLinkRowName>
            {/* A worker row has no tooltip: a state cut by its cap reads whole on hover here. */}
            <BotItemLinkRowStatus ownsStopSlot={canStop} title={state}>
              {link.state === 'working' ? (
                <>
                  <WorkerStateIcon state="running" />
                  <BotItemLinkRowStatusText>{state}</BotItemLinkRowStatusText>
                </>
              ) : (
                state
              )}
            </BotItemLinkRowStatus>
          </button>
        </HoverCardTrigger>
        {canStop ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('bots.activity.stopWorker', 'Stop {{value0}}', {
                  value0: worker.title
                })}
                disabled={stopping}
                onClick={stop}
                // Its slot is kept while hidden, so the state beside it never moves on hover. The
                // block reserves the same width after every other row's state (`--stop-slot`).
                className="invisible ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within/worker:visible group-hover/worker:visible hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                <Square className="size-2.5 fill-current" />
              </button>
            </TooltipTrigger>
            {/* Above, never over this row's state or the next row's. */}
            <TooltipContent side="top">{t('bots.activity.stop', 'Stop')}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <HoverCardContent
        side="bottom"
        align="start"
        variant="workspace-details"
        collisionPadding={BOT_ITEM_PANE_CARD_MARGIN}
        collisionBoundary={bounds?.boundary}
        style={
          bounds
            ? { maxWidth: bounds.maxWidth, maxHeight: `min(28rem, ${bounds.maxHeight}px)` }
            : undefined
        }
      >
        <WorkerActivityDetails
          title={worker.title}
          agent={worker.agent}
          summary={worker.summary}
          chat={chat}
          workspaceId={worker.worktreeId ?? null}
        />
      </HoverCardContent>
    </HoverCard>
  )
}

function Row({
  bot,
  chat,
  row,
  fileContext
}: {
  bot: Bot
  chat: string
  row: BotItemLinkRow
  fileContext: BotItemFileContext | undefined
}): React.JSX.Element {
  const t = useTranslate()
  switch (row.kind) {
    case 'worker':
      return <WorkerRow bot={bot} chat={chat} link={row.link} />
    case 'github':
      return <GitHubRow row={row} />
    case 'server-pr': {
      const name = t('bots.items.link.serverPr', 'PR not shown for server work yet')
      return (
        <BotItemLinkRowButton name={<span className="truncate">{name}</span>} tip={name} disabled />
      )
    }
    case 'web':
      return <WebRow row={row} />
    case 'file':
      return (
        <BotItemLinkRowButton
          name={<span className="min-w-0 truncate">{row.name}</span>}
          status={t('bots.items.link.file', 'File')}
          tip={row.path}
          disabled={!fileContext}
          onClick={() => {
            if (fileContext) {
              void openBotItemFile(row.path, fileContext)
            }
          }}
        />
      )
    case 'automation': {
      const name = row.name ?? t('bots.items.link.automation', 'Automation')
      const ended = t('bots.items.link.automationEnded', 'Ended')
      return (
        <BotItemLinkRowButton
          name={<span className="min-w-0 truncate">{name}</span>}
          status={row.active ? null : ended}
          tip={`${name} · ${
            row.active
              ? t('bots.items.link.automationOn', 'Will wake the agent for this item')
              : ended
          }`}
          disabled
        />
      )
    }
  }
}

/** The item's Links block; nothing at all for an item with none. */
export function BotItemLinksBlock({
  bot,
  links,
  chat
}: {
  bot: Bot
  links: readonly BotItemLinkView[]
  /** The item's chat, as a worker row's hover card names it. */
  chat: string
}): React.JSX.Element | null {
  return links.length === 0 ? null : <LinksBlock bot={bot} links={links} chat={chat} />
}

function LinksBlock({
  bot,
  links,
  chat
}: {
  bot: Bot
  links: readonly BotItemLinkView[]
  chat: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const rows = useMemo(() => botItemLinksOrder(botItemLinkRows(links)), [links])
  useBotItemPrWorkspacesVisible(rows)
  const fileContext = useBotItemFileContext(bot)
  const [expanded, setExpanded] = useState(false)
  const list = useRef<HTMLUListElement | null>(null)
  if (rows.length === 0) {
    return null
  }
  const shown = expanded ? rows : rows.slice(0, BOT_ITEM_LINKS_SHOWN)
  const more = rows.length - shown.length
  const label = t('bots.items.view.links', 'Links')
  // While a shown row has Stop, every state keeps its slot free too, so all states share one edge.
  const stopSlot = shown.some((row) => row.kind === 'worker' && workerCanStop(row.link))
  return (
    <section>
      <h3 className="mb-1 text-xs text-muted-foreground">{label}</h3>
      <NativeChatLinkPeekProvider
        fileLinkContext={fileContext?.fileLinkContext ?? null}
        hostId={bot.hostId}
      >
        <ul
          ref={list}
          tabIndex={-1}
          aria-label={label}
          data-stop-slot={stopSlot || undefined}
          className="group/links -mx-1.5 flex flex-col"
        >
          {shown.map((row) => (
            <li key={row.key} className="min-w-0" data-bot-item-cut="row">
              <Row bot={bot} chat={chat} row={row} fileContext={fileContext} />
            </li>
          ))}
        </ul>
      </NativeChatLinkPeekProvider>
      {more > 0 ? (
        <button
          type="button"
          aria-expanded={false}
          aria-label={t('bots.items.view.moreLinks', '{{count}} more links', {
            count: more
          })}
          // Quieter than the rows it stands for.
          className="mt-0.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => {
            // The button goes once the rest show: focus moves to the first of them that opens, not to the page.
            flushSync(() => setExpanded(true))
            const revealed = Array.from(list.current?.children ?? []).slice(BOT_ITEM_LINKS_SHOWN)
            for (const row of revealed) {
              const button = row.querySelector<HTMLButtonElement>('button:enabled')
              if (button) {
                button.focus()
                return
              }
            }
            list.current?.focus()
          }}
        >
          {t('bots.items.view.moreCount', '{{count}} more', { count: more })}
        </button>
      ) : null}
    </section>
  )
}

/** Files open only inside the bot's own folder. */
function useBotItemFileContext(bot: Bot): BotItemFileContext | undefined {
  return useBotGroupFileContexts(noFolders, bot, '').get(bot.id)
}
