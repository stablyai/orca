/* One link stays a chip. The rest share one count and a popover. */
import { ChevronDown, FileText, GitPullRequest, Hourglass, Link2, Square } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatLinkPeekProvider } from '@/components/native-chat/links/previews/native-chat-link-peek-context'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'
import {
  botItemLinkRows,
  botItemWorkerRow,
  type BotItemLinkRow
} from '../../../../../shared/bots/bot-item-link-rows'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import {
  botChatTreeWorkerOpen,
  botChatTreeWorkerRunning,
  WorkerStateIcon
} from '../BotChatTreeWorkerRow'
import { useWorkerStop, WorkerActivityDetails } from '../WorkerActivityRow'
import { openBotItemFile, type BotItemFileContext } from './bot-item-file-open'
import { BotItemChipButton as ChipButton } from './BotItemChipButton'
import { BotItemGitHubChip as GitHubChip } from './BotItemGitHubChip'
import {
  BotItemLinkRowList,
  useBotItemFileContext,
  useLinearTitle,
  useOpenWeb
} from './BotItemLinks'
import { useBotItemPrWorkspacesVisible } from './use-bot-item-live-pr'

export function BotItemLinkChips({
  bot,
  links,
  chat
}: {
  bot: Bot
  links: readonly BotItemLinkView[]
  /** The item's chat, as the overflow's worker rows name it. */
  chat: string
}): React.JSX.Element | null {
  // No links, no row, and nothing read for one.
  return links.length === 0 ? null : <LinkChips bot={bot} links={links} chat={chat} />
}

function LinkChips({
  bot,
  links,
  chat
}: {
  bot: Bot
  links: readonly BotItemLinkView[]
  chat: string
}): React.JSX.Element | null {
  const rows = useMemo(() => botItemLinkRows(links), [links])
  useBotItemPrWorkspacesVisible(rows)
  const fileContext = useBotItemFileContext(bot)
  if (rows.length === 0) {
    return null
  }
  return (
    <NativeChatLinkPeekProvider
      fileLinkContext={fileContext?.fileLinkContext ?? null}
      hostId={bot.hostId}
    >
      {rows.length === 1 ? (
        <div className="flex min-w-0 flex-1 basis-0">
          <Chip bot={bot} chat={chat} row={rows[0]!} fileContext={fileContext} />
        </div>
      ) : (
        <LinksMenu bot={bot} rows={rows} chat={chat} />
      )}
    </NativeChatLinkPeekProvider>
  )
}

/** Two or more links: their count, whose popover lists them all as full rows. */
function LinksMenu({
  bot,
  rows,
  chat
}: {
  bot: Bot
  rows: readonly BotItemLinkRow[]
  chat: string
}): React.JSX.Element {
  const t = useTranslate()
  const list = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  // The item's pane, read on open: the list stays inside it and is no wider than it.
  const [pane, setPane] = useState<Element | null>(null)
  const label = t('bots.items.view.linkCount', '{{count}} links', { count: rows.length })
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          setPane(trigger.current?.closest('[data-bot-item-focus-home]') ?? null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button ref={trigger} variant="ghost" size="xs" className="shrink-0" aria-label={label}>
          <Link2 className="size-3 text-muted-foreground" />
          {/* Only the count in a narrow pane, so the row never cuts its controls. */}
          <span className="@max-[290px]:hidden">{label}</span>
          <span className="hidden tabular-nums @max-[290px]:inline">{rows.length}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionBoundary={pane}
        collisionPadding={8}
        className="w-80 max-w-(--radix-popover-content-available-width)"
        wheelScroll
        // The list takes focus, not its first row: a focused worker row opens its hover card over
        // the header. Tab goes on to the rows from here.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          list.current?.focus()
        }}
      >
        <div
          ref={list}
          tabIndex={-1}
          className="scrollbar-sleek max-h-[min(15rem,var(--radix-popover-content-available-height,15rem))] overflow-y-auto p-1 outline-none"
        >
          <BotItemLinkRowList bot={bot} rows={rows} chat={chat} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A worker, as its row in the full list offers it: open on click, its details card on hover or
 *  focus, and Stop beside its name while it runs. */
function WorkerChip({
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
  const canStop = botChatTreeWorkerRunning(worker) && Boolean(worker.dispatchId)
  const { stopping, stop } = useWorkerStop(worker.dispatchId ?? '')
  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <div className="flex h-6 min-w-0 max-w-60 items-center rounded-md border border-border bg-background text-xs text-foreground">
        <HoverCardTrigger asChild>
          <button
            type="button"
            disabled={!open}
            onClick={open}
            className="flex h-full min-w-0 items-center gap-1.5 rounded-md px-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:text-muted-foreground disabled:hover:bg-transparent"
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <WorkerStateIcon state={worker.state} />
            </span>
            <span className="min-w-0 truncate">{worker.title}</span>
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
                className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                <Square className="size-2.5 fill-current" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('bots.activity.stop', 'Stop')}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <HoverCardContent side="bottom" align="start" variant="workspace-details">
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

function Chip({
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
      return <WorkerChip bot={bot} chat={chat} link={row.link} />
    case 'github':
      return <GitHubChip row={row} />
    case 'server-pr':
      return (
        <ChipButton
          icon={<GitPullRequest className="size-3.5 text-muted-foreground" />}
          label={t('bots.items.link.serverPr', 'PR not shown for server work yet')}
          disabled
        />
      )
    case 'web':
      return <WebChip row={row} />
    case 'file':
      return <FileChip row={row} fileContext={fileContext} />
    case 'automation':
      return (
        <ChipButton
          icon={<Hourglass className="size-3.5 text-muted-foreground" />}
          label={row.name ?? t('bots.items.link.automation', 'Automation')}
          tip={
            row.active
              ? t('bots.items.link.automationOn', 'Will wake the agent for this item')
              : t('bots.items.link.automationEnded', 'Ended')
          }
          disabled={!row.active}
        />
      )
  }
}

function WebChip({ row }: { row: Extract<BotItemLinkRow, { kind: 'web' }> }): React.JSX.Element {
  const linearTitle = useLinearTitle(row.linear)
  const openWeb = useOpenWeb()
  return (
    <ChipButton
      icon={
        row.brand ? (
          <BotAppBrandLogo app={{ id: row.brand }} size="xs" />
        ) : (
          <Link2 className="size-3.5 text-muted-foreground" />
        )
      }
      label={linearTitle ?? row.title}
      suffix={linearTitle ? row.title : null}
      tip={row.tip}
      onClick={(event) => openWeb(row.url, event)}
    />
  )
}

function FileChip({
  row,
  fileContext
}: {
  row: Extract<BotItemLinkRow, { kind: 'file' }>
  fileContext: BotItemFileContext | undefined
}): React.JSX.Element {
  return (
    <ChipButton
      icon={<FileText className="size-3.5 text-muted-foreground" />}
      label={row.name}
      tip={row.path}
      disabled={!fileContext}
      onClick={() => {
        if (fileContext) {
          void openBotItemFile(row.path, fileContext)
        }
      }}
    />
  )
}
