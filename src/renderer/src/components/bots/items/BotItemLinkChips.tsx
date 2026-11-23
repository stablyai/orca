// An item's links as one or two lines of chips under its frozen title, so they stay in view while the
// owner reads and answers lower down. Each chip opens its link as its row in the full list would; the
// chips with no room go behind "+N", whose popover lists them as full rows.
import { FileText, GitPullRequest, Hourglass, Link2, Square } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { getTaskPageGitHubWorkItemStateLabel } from '@/components/task-page/github/listing/task-page-github-work-item-status'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemLinkView, BotItemWorkerState } from '../../../../../shared/bots/bot-items'
import {
  botItemLinkRows,
  botItemWorkerRow,
  type BotItemGitHubRow,
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
import {
  BotItemLinkRowList,
  checksLabel,
  gitHubIcon,
  useBotItemFileContext,
  useLinearTitle,
  useOpenWeb
} from './BotItemLinks'

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
  const t = useTranslate()
  const rows = useMemo(() => botItemLinkChipOrder(botItemLinkRows(links)), [links])
  const fileContext = useBotItemFileContext(bot)
  const list = useRef<HTMLUListElement | null>(null)
  const overflow = useRef<HTMLDivElement | null>(null)
  const shown = useChipsThatFit(list, rows)
  if (rows.length === 0) {
    return null
  }
  const rest = rows.slice(shown)
  return (
    <div className="flex min-w-0 items-end gap-1">
      {/* Two lines tall, one in a short window; a chip past the last line is clipped, out of Tab and
          the accessibility tree, and "+N" lists it. Only a resize or a chip's own change measures again, never a scroll. */}
      <ul
        ref={list}
        aria-label={t('bots.items.view.links', 'Links')}
        className="relative flex max-h-[52px] min-w-0 flex-1 flex-wrap gap-1 overflow-hidden [@media(max-height:620px)]:max-h-6"
      >
        {rows.map((row, index) => (
          <li
            key={row.key}
            inert={index >= shown}
            aria-hidden={index >= shown || undefined}
            className="flex min-w-0 max-w-full"
          >
            <Chip bot={bot} chat={chat} row={row} fileContext={fileContext} />
          </li>
        ))}
      </ul>
      {rest.length > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              aria-label={t('bots.items.view.moreLinks', '{{count}} more links', {
                count: rest.length
              })}
            >
              <span className="tabular-nums">+{rest.length}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-80"
            wheelScroll
            // The list takes focus, not its first row: a focused worker row opens its hover card over
            // the header. Tab goes on to the rows from here.
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              overflow.current?.focus()
            }}
          >
            <div
              ref={overflow}
              tabIndex={-1}
              className="scrollbar-sleek max-h-60 overflow-y-auto p-1 outline-none"
            >
              <BotItemLinkRowList bot={bot} rows={rest} chat={chat} />
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}

/** The list's order, but a worker that has finished goes last: with many links, the ones still
 *  moving and the PRs keep their place in view, and a finished worker is the first behind "+N". */
export function botItemLinkChipOrder(rows: readonly BotItemLinkRow[]): BotItemLinkRow[] {
  const settled = (row: BotItemLinkRow): boolean =>
    row.kind === 'worker' && SETTLED_WORKER.has(row.link.state)
  return [...rows.filter((row) => !settled(row)), ...rows.filter(settled)]
}

const SETTLED_WORKER: ReadonlySet<BotItemWorkerState> = new Set([
  'completed',
  'failed',
  'stopped',
  'missing'
])

/** How many chips, from the first, sit wholly inside the list's box. Read on mount and when the list or
 *  a chip changes size, never on scroll; a clipped chip has nothing to read later but its own box. */
function useChipsThatFit(
  list: React.RefObject<HTMLUListElement | null>,
  rows: readonly BotItemLinkRow[]
): number {
  const count = rows.length
  // A new set of chips is new elements to watch; a chip that only changes its text keeps its element.
  const keys = rows.map((row) => row.key).join('\n')
  const [shown, setShown] = useState(count)
  useLayoutEffect(() => {
    const root = list.current
    if (!root) {
      return
    }
    const measure = (): void => {
      const height = root.clientHeight
      const chips = Array.from(root.children).filter(
        (chip): chip is HTMLElement => chip instanceof HTMLElement
      )
      const firstClipped = chips.findIndex(
        (chip) => chip.offsetTop + chip.offsetHeight > height + 0.5
      )
      setShown(firstClipped === -1 ? chips.length : firstClipped)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    for (const chip of Array.from(root.children)) {
      observer.observe(chip)
    }
    return () => observer.disconnect()
  }, [list, keys])
  return Math.min(shown, count)
}

/** One link: an icon and a short name, cut to fit; the whole name and what a row says is on hover. */
function ChipButton({
  icon,
  label,
  suffix,
  tip,
  disabled,
  onClick
}: {
  icon: ReactNode
  label: string
  suffix?: string | null
  tip?: string
  disabled?: boolean
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  const chip = (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 min-w-0 max-w-60 items-center gap-1.5 rounded-md border border-border bg-background px-1.5 text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:text-muted-foreground disabled:hover:bg-background"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {suffix ? (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{suffix}</span>
      ) : null}
    </button>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-80">
        {tip ? `${label} · ${tip}` : label}
      </TooltipContent>
    </Tooltip>
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

function GitHubChip({ row }: { row: BotItemGitHubRow }): React.JSX.Element {
  const t = useTranslate()
  const openWeb = useOpenWeb()
  const tip = [
    row.state
      ? getTaskPageGitHubWorkItemStateLabel({ type: row.type, state: row.state }, t)
      : t('bots.items.link.notRead', 'Not read yet'),
    checksLabel(t, row.checks),
    row.repo
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ChipButton
      icon={gitHubIcon(row)}
      label={
        row.title ??
        (row.type === 'pr'
          ? t('bots.items.link.pr', 'PR #{{number}}', { number: row.number })
          : t('bots.items.link.issue', 'Issue #{{number}}', {
              number: row.number
            }))
      }
      suffix={row.title ? `#${row.number}` : null}
      tip={tip}
      onClick={(event) => openWeb(row.url, event)}
    />
  )
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
