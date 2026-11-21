// The Share dialog's parts: the bot as the link shows it, the live link, the secret notice and a
// drill-in page. BotShareFlow decides which show, from the bot's link and the candidate.
import { Check, CloudOff, Copy, Link2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'
import { SettingsInsetGroup } from '../settings-view/BotSettingsRows'
import { botShareFlagLabel, type BotShareFlagSpot } from './bot-share-flags'
import type { BotShareContext, BotSharePage } from './bot-share-pages'
import { BotShareListPage } from './BotShareLists'
import { pageTitle } from './BotShareOverview'
import { BotSharePartFiles } from './BotSharePartView'
import { BotShareBack } from './BotShareRows'

const UPDATED_AT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
}

export function SkeletonBar({ width }: { width: number }): React.JSX.Element {
  return <span className="inline-block h-[9px] rounded bg-foreground/10" style={{ width }} />
}

/** Picture, name and purpose, centred: what the link shows. The purpose comes with the candidate,
 *  read from SOUL.md, so it waits on it. */
export function BotShareHero({
  bot,
  purpose,
  compact
}: {
  bot: Bot
  /** undefined while the candidate builds; null to leave the line out (signed out). */
  purpose: string | null | undefined
  compact: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col items-center px-3 pt-1 text-center">
      <BotAvatar
        bot={bot}
        className={cn(
          compact ? 'size-12 rounded-[12px] text-xl' : 'size-16 rounded-[16px] text-[26px]'
        )}
      />
      <DialogTitle
        className={cn('max-w-full [overflow-wrap:anywhere]', compact ? 'mt-2.5' : 'mt-3')}
      >
        <span className="line-clamp-2">{bot.name}</span>
      </DialogTitle>
      {purpose === null ? (
        <DialogDescription className="sr-only">{bot.name}</DialogDescription>
      ) : purpose === undefined ? (
        <span className="mt-1 flex h-5 items-center">
          <SkeletonBar width={220} />
        </span>
      ) : (
        <DialogDescription className="mt-1 max-w-[380px] [overflow-wrap:anywhere]">
          <span className="line-clamp-2">
            {purpose || t('bots.share.noPurpose', 'No purpose yet')}
          </span>
        </DialogDescription>
      )}
    </div>
  )
}

/** The live link with Copy link, and the line under it saying when it last changed. */
export function BotShareLinkBlock({
  url,
  copied,
  meta,
  onCopy
}: {
  url: string | null
  copied: boolean
  meta: React.ReactNode
  onCopy: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-2">
      <SettingsInsetGroup>
        <div className="flex min-h-11 items-center gap-2.5 py-1.5 pr-1.5 pl-3">
          <Link2 className="size-4 shrink-0 text-muted-foreground" />
          {url ? (
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {url.replace(/^https:\/\//, '')}
            </span>
          ) : (
            <span className="flex min-w-0 flex-1">
              <SkeletonBar width={200} />
            </span>
          )}
          {url ? (
            <Button type="button" variant="outline" size="sm" onClick={onCopy}>
              {copied ? <Check /> : <Copy />}
              {copied ? t('bots.share.copied', 'Copied') : t('bots.share.copyLink', 'Copy link')}
            </Button>
          ) : null}
        </div>
      </SettingsInsetGroup>
      {url && meta ? (
        <p className="flex items-center justify-center gap-1.5 text-xs leading-4 text-muted-foreground">
          {meta}
        </p>
      ) : null}
    </div>
  )
}

/** "Updated Nov 9, 3:12 PM · Up to date". */
export function BotShareUpdatedLine({
  updatedAt,
  upToDate
}: {
  updatedAt: string | null
  /** null while the bot hasn't been compared with what the link serves. */
  upToDate: boolean | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const date = updatedAt ? new Date(updatedAt) : null
  if (!date || Number.isNaN(date.getTime())) {
    return null
  }
  return (
    <>
      {t('bots.share.updatedAt', 'Updated {{date}}', {
        date: uiDateTimeFormat(UPDATED_AT, intlLocale).format(date)
      })}
      {upToDate === null ? null : (
        <>
          <span aria-hidden className="opacity-60">
            ·
          </span>
          {upToDate
            ? t('bots.share.upToDate', 'Up to date')
            : t('bots.share.changedSince', 'Bot changed since')}
        </>
      )}
    </>
  )
}

/** Orca Cloud didn't answer, so whether the bot has a link is unknown; Publish waits on Retry. */
export function BotShareOfflineRow({
  error,
  onRetry
}: {
  error: string | null
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsInsetGroup>
      <div className="flex min-h-11 items-center gap-2.5 py-2 pr-2.5 pl-3 text-sm">
        <CloudOff className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-medium">
          {error ?? t('bots.share.linkStatusUnavailable', 'Couldn’t check the share link')}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('settings.bots.retry', 'Retry')}
        </Button>
      </div>
    </SettingsInsetGroup>
  )
}

/** A secret blocks publishing: where it is, View and Go to line. */
export function BotShareSecretNotice({
  spot,
  onView,
  onGoToLine
}: {
  spot: BotShareFlagSpot
  onView: (() => void) | null
  onGoToLine: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsInsetGroup>
      <div className="flex min-h-11 items-start gap-2.5 py-2 pr-2.5 pl-3 text-sm">
        <TriangleAlert className="mt-px size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">
          <span className="block leading-[18px] font-medium">
            {t('bots.share.secretFoundTitle', 'Secret found')}
          </span>
          <span className="block truncate text-xs leading-4 text-muted-foreground">
            {spot.flag.line === null
              ? spot.where
              : t('bots.share.secretWhere', '{{flag}} in {{where}}, line {{line}}', {
                  flag: botShareFlagLabel(spot.flag.kind),
                  where: spot.where,
                  line: spot.flag.line
                })}
          </span>
        </span>
        {onView ? (
          <Button type="button" size="xs" variant="ghost" onClick={onView}>
            {t('bots.share.view', 'View')}
          </Button>
        ) : null}
        {onGoToLine ? (
          <Button type="button" size="xs" variant="outline" onClick={onGoToLine}>
            {t('bots.share.goToLine', 'Go to line')}
          </Button>
        ) : null}
      </div>
    </SettingsInsetGroup>
  )
}

/** A part's page in place of the dialog's front: Back, its title, and its items or text. */
/** A page takes focus at its title as it opens, so nothing below (such as Cancel) looks chosen. */
function focusOnOpen(title: HTMLDivElement | null): void {
  title?.focus({ preventScroll: true })
}

export function BotShareDrillIn({
  page,
  backLabel,
  onBack,
  ctx
}: {
  page: BotSharePage
  backLabel: string
  onBack: () => void
  ctx: BotShareContext
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DialogTitle className="sr-only">{pageTitle(page, t)}</DialogTitle>
      <DialogDescription className="sr-only">{ctx.bot.name}</DialogDescription>
      <div className="flex min-h-7 items-center">
        <BotShareBack label={backLabel} onBack={onBack} />
      </div>
      <div ref={focusOnOpen} tabIndex={-1} className="outline-none">
        <div className="flex items-baseline gap-2 text-sm leading-5 font-semibold">
          {pageTitle(page, t)}
          {page.kind === 'list' && page.list === 'memory' ? (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              {t('bots.share.countOf', '{{picked}} of {{all}}', {
                picked: ctx.selection.memory?.length ?? 0,
                all: ctx.candidate.available.memory.length
              })}
            </span>
          ) : null}
        </div>
        {page.kind === 'part' && page.detail ? (
          <div className="text-xs leading-4 text-muted-foreground">{page.detail}</div>
        ) : null}
      </div>
      {page.kind === 'part' ? (
        <BotSharePartFiles
          bot={ctx.bot}
          candidateId={ctx.candidate.candidateId}
          part={page.part}
          showNames={page.showNames === true}
        />
      ) : (
        <BotShareListPage list={page.list} ctx={ctx} />
      )}
    </>
  )
}
