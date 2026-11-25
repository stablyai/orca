import { inheritBotRecordOwner } from '../../automations/hosts/bot-automation-row-owner'
// An item's links, one row layout for all: workers as the Chats tab draws them, then PRs and issues with
// live state, other links, files. Every link opens on click or Enter: web links as the workspace card's
// linked PR does (the link setting's popover or browser), files in Orca's editor, only from the bot's folder.
import {
  Check,
  CircleCheck,
  CircleDot,
  FileText,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hourglass,
  Link2,
  X,
  type LucideIcon
} from 'lucide-react'
import { useContext, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { HoverScrollText } from '@/components/hover-scroll-text'
import { useNativeChatLinkClick } from '@/components/native-chat/links/actions/native-chat-link-click-context'
import { NativeChatLinkPeek } from '@/components/native-chat/links/previews/NativeChatLinkPeek'
import { hasGitHubLinkPeek } from '@/components/native-chat/links/previews/NativeChatGitHubLinkPeek'
import { NativeChatLinkPeekContext } from '@/components/native-chat/links/previews/native-chat-link-peek-context'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getTaskPageGitHubPRIconTone,
  getTaskPageGitHubWorkItemStateLabel
} from '@/components/task-page/github/listing/task-page-github-work-item-status'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'
import { ActivityRowButton } from '../ActivityRowButton'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { BotChatTreeWorkerRow } from '../BotChatTreeWorkerRow'
import { useBotGroupFileContexts } from '../BotGroupTranscriptOwner'
import {
  BOT_ITEM_LINK_ROWS,
  botItemLinkPage,
  botItemWorkerRow,
  type BotItemGitHubRow,
  type BotItemLinkRow
} from '../../../../../shared/bots/bot-item-link-rows'
import { openBotItemFile, type BotItemFileContext } from './bot-item-file-open'
import { useBotItemLivePr } from './use-bot-item-live-pr'
import {
  checksLabel,
  GITHUB_RETRY_KEY,
  useGitHubLinkPeekFallback
} from './bot-item-github-peek-content'

const PR_ICONS: Record<NonNullable<BotItemGitHubRow['state']>, LucideIcon> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed
}

const noFolders: never[] = []

/** One line per link; what a second line would say (domain, folder, repo, state) is on hover. */
function LinkRow({
  tip,
  ...row
}: React.ComponentProps<typeof ActivityRowButton> & {
  tip?: string
}): React.JSX.Element {
  const line = (
    <div className={cn('flex w-full min-w-0 rounded-sm', !row.disabled && 'hover:bg-accent')}>
      <ActivityRowButton nested={{ settled: false }} {...row} />
    </div>
  )
  if (!tip) {
    return line
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{line}</TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}

/** A title, then a muted label beside it that stays whole. */
function TitleWithLabel({
  title,
  label,
  muted
}: {
  title: ReactNode
  label: ReactNode
  muted?: boolean
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <HoverScrollText className={cn(muted && 'text-muted-foreground')}>{title}</HoverScrollText>
      {label ? (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{label}</span>
      ) : null}
    </span>
  )
}

/** A long host and path loses its middle, so the last path segment stays readable. */
function MiddleTruncated({ text }: { text: string }): React.JSX.Element {
  const cut = text.lastIndexOf('/') + 1
  return (
    <span className="flex min-w-0">
      <span className="min-w-0 truncate">{text.slice(0, cut)}</span>
      <span className="max-w-[60%] shrink-0 truncate">{text.slice(cut)}</span>
    </span>
  )
}

// Each cache the store holds, its titles by upper-cased identifier: built once per cache, shared by
// every Linear row, so a store write elsewhere costs a row one lookup, not a scan of the cache.
const linearTitlesByCache = new WeakMap<AppState['linearIssueCache'], ReadonlyMap<string, string>>()

function linearTitles(cache: AppState['linearIssueCache']): ReadonlyMap<string, string> {
  let titles = linearTitlesByCache.get(cache)
  if (!titles) {
    const byIdentifier = new Map<string, string>()
    for (const entry of Object.values(cache)) {
      const identifier = entry?.data?.identifier.toUpperCase()
      if (identifier && entry?.data && !byIdentifier.has(identifier)) {
        byIdentifier.set(identifier, entry.data.title)
      }
    }
    titles = byIdentifier
    linearTitlesByCache.set(cache, titles)
  }
  return titles
}

/** A Linear issue's title, when Orca's Linear cache has read it; never a fetch of its own. */
export function useLinearTitle(identifier: string | null): string | null {
  return useAppStore((state) =>
    identifier ? (linearTitles(state.linearIssueCache).get(identifier) ?? null) : null
  )
}

/** The item view's link handler: the workspace card's popover and destinations, from the bot's folder. A
 *  click it leaves alone (a plain click when the setting opens nothing) goes to the system browser, as the
 *  workspace card's link falls through to its anchor. */
export function useOpenWeb(): (url: string, event: MouseEvent<HTMLElement>) => void {
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

/** Shape and color both say the state, as the task page draws PRs; an issue reads green open, purple done. */
export function gitHubIcon(row: BotItemGitHubRow): React.JSX.Element {
  if (!row.state) {
    const Icon = row.type === 'pr' ? GitPullRequest : CircleDot
    return <Icon className="size-3.5 text-muted-foreground" />
  }
  if (row.type === 'issue') {
    const done = row.state === 'closed'
    const Icon = done ? CircleCheck : CircleDot
    return (
      <Icon
        className={cn(
          'size-3.5',
          getTaskPageGitHubPRIconTone({
            type: 'pr',
            state: done ? 'merged' : 'open'
          })
        )}
      />
    )
  }
  const Icon = PR_ICONS[row.state]
  return (
    <Icon
      className={cn('size-3.5', getTaskPageGitHubPRIconTone({ type: 'pr', state: row.state }))}
    />
  )
}

/** CI only where it can still change: open and draft PRs, and only once it has an outcome. */
function ciGlyph(t: Translate, row: BotItemGitHubRow): React.JSX.Element | null {
  if (
    row.type !== 'pr' ||
    (row.state !== 'open' && row.state !== 'draft') ||
    (row.checks !== 'success' && row.checks !== 'failure')
  ) {
    return null
  }
  const ok = row.checks === 'success'
  const Icon = ok ? Check : X
  return (
    <Icon
      role="img"
      aria-label={checksLabel(t, row.checks) ?? undefined}
      strokeWidth={2.5}
      className={cn('size-3', ok ? 'text-status-success' : 'text-destructive')}
    />
  )
}

function GitHubRow({ row: hostRow }: { row: BotItemGitHubRow }): React.JSX.Element {
  const row = useBotItemLivePr(hostRow)
  const t = useTranslate()
  const openWeb = useOpenWeb()
  // Under the item page's chips, "+N" rows show the chips' GitHub card instead of the tooltip.
  const card = hasGitHubLinkPeek(useContext(NativeChatLinkPeekContext), row.url)
  const where = `${row.showRepo ? row.repo : ''}#${row.number}`
  const tip = [
    row.state
      ? getTaskPageGitHubWorkItemStateLabel({ type: row.type, state: row.state }, t)
      : t('bots.items.link.notRead', 'Not read yet'),
    checksLabel(t, row.checks),
    row.repo
  ]
    .filter(Boolean)
    .join(' · ')
  const name =
    row.title ??
    (row.type === 'pr'
      ? t('bots.items.link.pr', 'PR #{{number}}', {
          number: row.number
        })
      : t('bots.items.link.issue', 'Issue #{{number}}', {
          number: row.number
        }))
  const fallback = useGitHubLinkPeekFallback(name, tip)
  const line = (
    <LinkRow
      icon={gitHubIcon(row)}
      title={
        <TitleWithLabel
          title={name}
          label={row.title ? where : row.showRepo ? row.repo : null}
          muted={!row.title}
        />
      }
      meta={ciGlyph(t, row)}
      metaClassName="self-center"
      tip={card ? undefined : tip}
      onClick={(event) => openWeb(row.url, event)}
    />
  )
  return card ? (
    // Beside the "+N" list, as a worker row's card opens, so it covers no other row.
    <NativeChatLinkPeek
      href={row.url}
      side="left"
      githubFallback={fallback.pending}
      githubFailedFallback={fallback.failed}
      retryKey={GITHUB_RETRY_KEY}
      overPopover
    >
      {line}
    </NativeChatLinkPeek>
  ) : (
    line
  )
}

function WebRow({ row }: { row: Extract<BotItemLinkRow, { kind: 'web' }> }): React.JSX.Element {
  const linearTitle = useLinearTitle(row.linear)
  const openWeb = useOpenWeb()
  return (
    <LinkRow
      icon={
        row.brand ? (
          <BotAppBrandLogo app={{ id: row.brand }} size="xs" />
        ) : (
          <Link2 className="size-3.5 text-muted-foreground" />
        )
      }
      title={
        linearTitle ? (
          <TitleWithLabel title={linearTitle} label={row.title} />
        ) : row.linear ? (
          <HoverScrollText>{row.title}</HoverScrollText>
        ) : (
          <MiddleTruncated text={row.title} />
        )
      }
      tip={row.tip}
      onClick={(event) => openWeb(row.url, event)}
    />
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
      return (
        <BotChatTreeWorkerRow
          bot={bot}
          worker={inheritBotRecordOwner(row.link, botItemWorkerRow(row.link))}
          chat={chat}
        />
      )
    case 'github':
      return <GitHubRow row={row} />
    case 'server-pr':
      return (
        <LinkRow
          icon={<GitPullRequest className="size-3.5 text-muted-foreground" />}
          title={
            <span className="text-muted-foreground">
              {t('bots.items.link.serverPr', 'PR not shown for server work yet')}
            </span>
          }
          disabled
        />
      )
    case 'web':
      return <WebRow row={row} />
    case 'file':
      return (
        <LinkRow
          icon={<FileText className="size-3.5 text-muted-foreground" />}
          title={<HoverScrollText>{row.name}</HoverScrollText>}
          tip={row.path}
          disabled={!fileContext}
          onClick={() => {
            if (fileContext) {
              void openBotItemFile(row.path, fileContext)
            }
          }}
        />
      )
    case 'automation':
      return (
        <LinkRow
          icon={<Hourglass className="size-3.5 text-muted-foreground" />}
          title={row.name ?? t('bots.items.link.automation', 'Automation')}
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

export function BotItemLinks({
  bot,
  links,
  chat
}: {
  bot: Bot
  links: readonly BotItemLinkView[]
  /** The item's chat, as the worker row's hover card names it. */
  chat: string
}): React.JSX.Element {
  return <BotItemLinkRowList bot={bot} links={links} chat={chat} />
}

/** An item's links as rows, newest page first; each Show more adds the next older page. */
export function BotItemLinkRowList({
  bot,
  links,
  chat
}: {
  bot: Bot
  links: readonly BotItemLinkView[]
  chat: string
}): React.JSX.Element {
  const t = useTranslate()
  const fileContext = useBotItemFileContext(bot)
  const [shown, setShown] = useState(BOT_ITEM_LINK_ROWS)
  const { rows, more } = useMemo(() => botItemLinkPage(links, shown), [links, shown])
  return (
    <div className="flex flex-col">
      {rows.map((row) => (
        <Row key={row.key} bot={bot} chat={chat} row={row} fileContext={fileContext} />
      ))}
      {more > 0 ? (
        <button
          type="button"
          className="self-start px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShown(shown + BOT_ITEM_LINK_ROWS)}
        >
          {t('bots.items.group.showMore', 'Show {{count}} more', { count: more })}
        </button>
      ) : null}
    </div>
  )
}

/** Files open only inside the bot's own folder. */
export function useBotItemFileContext(bot: Bot): BotItemFileContext | undefined {
  return useBotGroupFileContexts(noFolders, bot, '').get(bot.id)
}
