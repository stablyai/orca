import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import type { ResumeFailureAction } from '../failures/native-chat-resume-failure-guidance'
import {
  resumeToastShowsDetails,
  type ResumeToastRow,
  type ResumeToastView
} from './native-chat-resume-toast-view'
import { NativeChatResumeToastRow } from './NativeChatResumeToastRow'

export type NativeChatResumeToastProps = {
  view: ResumeToastView
  /** Set for a paired server; its chats are named with the machine. */
  machineName?: string
  listedAt: number
  nameFor: (sessionId: string, fallback: string) => string
  defaultExpanded?: boolean
  onResume: (sessionIds: readonly string[]) => void
  onRowAction: (action: ResumeFailureAction, sessionId: string) => void
  /** Opening the list keeps the report until it is closed. */
  onDetailsOpened?: () => void
  /** Local only: deletes the durable offer. A server's chats can only be hidden by closing. */
  onDismissAll?: () => void
  onOpenSettings: () => void
  onClose: () => void
}

/** Offer lines say why the agents stopped; the rest are one line, naming a lone agent. */
function headline(
  view: ResumeToastView,
  t: Translate,
  machine: string | undefined,
  onlyName: string | undefined
): string {
  const { phase, counts } = view
  if (phase === 'offer') {
    return stoppedHeadline(view, t, machine)
  }
  if (leftForPerson(view) && counts.resumed === 0) {
    return needYouLine(view, t)
  }
  return progressLine(view, t, onlyName)
}

function needYouLine(view: ResumeToastView, t: Translate): string {
  return t('auto.components.NativeChatResumeToast.needYou', '{{count}} need you', {
    count: view.counts.needsYou,
    defaultValue_one: '{{count}} needs you'
  })
}

/** Agents left for the person (waiting on an approval) were never tried, so nothing failed. */
function leftForPerson({ phase, counts }: ResumeToastView): boolean {
  return phase === 'finished' && counts.failed === 0 && counts.needsYou > 0
}

function progressLine(view: ResumeToastView, t: Translate, onlyName: string | undefined): string {
  const { phase, counts } = view
  const name = { name: onlyName }
  if (phase === 'resuming') {
    return onlyName !== undefined
      ? t('auto.components.NativeChatResumeToast.resumingOne', 'Resuming {{name}}…', name)
      : t('auto.components.NativeChatResumeToast.resuming', 'Resuming {{count}} agents…', {
          count: counts.resuming,
          defaultValue_one: 'Resuming {{count}} agent…'
        })
  }
  if (counts.failed > 0) {
    return onlyName !== undefined
      ? t('auto.components.NativeChatResumeToast.failedOne', 'Couldn’t resume {{name}}', name)
      : t(
          'auto.components.NativeChatResumeToast.failedSome',
          'Couldn’t resume {{count}} of {{total}}',
          {
            count: counts.failed,
            total: counts.total,
            defaultValue_one: 'Couldn’t resume {{count}} of {{total}}'
          }
        )
  }
  return onlyName !== undefined
    ? t('auto.components.NativeChatResumeToast.resumedOne', 'Resumed {{name}}', name)
    : t('auto.components.NativeChatResumeToast.resumedMany', 'Resumed {{count}} agents', {
        count: counts.resumed,
        defaultValue_one: 'Resumed {{count}} agent'
      })
}

function stoppedHeadline(view: ResumeToastView, t: Translate, machineName?: string): string {
  const { counts } = view
  if (machineName) {
    return t(
      'auto.components.NativeChatResumeToast.stoppedOn',
      '{{count}} agents stopped on {{machine}}.',
      {
        count: counts.total,
        machine: machineName,
        defaultValue_one: '{{count}} agent stopped on {{machine}}.'
      }
    )
  }
  return view.interruptedByUpdate
    ? t(
        'auto.components.NativeChatResumeToast.stoppedUpdate',
        '{{count}} agents stopped when Orca updated.',
        {
          count: counts.total,
          defaultValue_one: '{{count}} agent stopped when Orca updated.'
        }
      )
    : t(
        'auto.components.NativeChatResumeToast.stoppedRestart',
        '{{count}} agents stopped when Orca closed.',
        {
          count: counts.total,
          defaultValue_one: '{{count}} agent stopped when Orca closed.'
        }
      )
}

function HeadlineIcon({ view }: { view: ResumeToastView }): React.JSX.Element {
  if (view.phase === 'resuming') {
    return (
      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
    )
  }
  if (view.counts.needsYou > 0) {
    return <AlertCircle className="size-4 shrink-0 text-status-warning" />
  }
  if (view.phase === 'finished') {
    return <CheckCircle2 className="size-4 shrink-0 text-status-success" />
  }
  return <RotateCcw className="size-4 shrink-0 text-muted-foreground" />
}

/** The resume-on-restart report: one line once resuming starts, any other agents behind Details. */
export function NativeChatResumeToast({
  view,
  machineName,
  listedAt,
  nameFor,
  defaultExpanded = false,
  onResume,
  onRowAction,
  onDetailsOpened,
  onDismissAll,
  onOpenSettings,
  onClose
}: NativeChatResumeToastProps): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const titleId = useId()
  const listId = useId()
  const busy = view.phase === 'resuming'
  const listRef = useRef<HTMLUListElement>(null)
  const [moreBelow, setMoreBelow] = useState(false)
  const rowCount = view.rows.length
  useEffect(() => {
    if (expanded && listRef.current) {
      setMoreBelow(hasMoreBelow(listRef.current))
    }
  }, [expanded, rowCount])
  const rowName = (row: ResumeToastRow): string =>
    nameFor(
      row.candidate.sessionId,
      firstLine(row.candidate.latestPrompt) ||
        t('auto.components.NativeChatResumeToast.untitled', 'Untitled agent')
    )
  const offering = view.phase === 'offer'
  const onlyRow = rowCount === 1 ? view.rows[0] : undefined
  const namesAgent = onlyRow !== undefined && !offering && !leftForPerson(view)
  const title = headline(view, t, machineName, namesAgent ? rowName(onlyRow) : undefined)
  const showResume = offering && view.resumable.length > 0
  const needYou = leftForPerson(view) && view.counts.resumed > 0 ? needYouLine(view, t) : undefined
  const showRetry = view.phase === 'finished' && view.retryable.length > 0
  const showDetails = resumeToastShowsDetails(view)
  const showDismissAll = onDismissAll !== undefined && offering
  const detailsButton = showDetails && (
    <Button
      variant={offering ? 'ghost' : 'ghost-muted-disclosure'}
      size={offering ? 'xs' : 'xs-compact'}
      className={offering && !showResume ? '-ml-2' : undefined}
      aria-expanded={expanded}
      aria-controls={listId}
      onClick={() => {
        if (!expanded) {
          onDetailsOpened?.()
        }
        setExpanded(!expanded)
      }}
    >
      {t('auto.components.NativeChatResumeToast.details', 'Details')}
    </Button>
  )
  return (
    <section
      aria-labelledby={titleId}
      className="w-full overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-floating"
    >
      <div
        className={`flex min-w-0 py-2 pr-1 pl-3 ${offering ? 'items-start gap-2' : 'items-center gap-1.5'}`}
      >
        <span className={`inline-flex shrink-0 ${offering ? 'mt-0.5' : 'mr-0.5'}`}>
          <HeadlineIcon view={view} />
        </span>
        <div className="min-w-0 flex-1">
          {/* The status line is what changes, so it alone is announced; it stays mounted across phases. */}
          <div role="status">
            {offering ? (
              <p
                id={titleId}
                className="text-[13px] leading-snug font-medium break-keep [overflow-wrap:anywhere]"
              >
                {title}
              </p>
            ) : (
              <p
                id={titleId}
                className="@container flex min-w-0 items-baseline gap-1.5 text-[13px] leading-snug font-medium"
              >
                <span
                  className={
                    namesAgent || needYou ? 'min-w-0 truncate' : 'max-w-full shrink-0 truncate'
                  }
                  title={machineName ? `${title} · ${machineName}` : title}
                >
                  {title}
                </span>
                {/* Who still needs the person matters most, so it never gives way. */}
                {needYou && (
                  <span className="shrink-0 font-normal whitespace-nowrap text-muted-foreground">
                    {needYou}
                  </span>
                )}
                {/* A server's name yields first: capped beside a name, only announced where it can't be read. */}
                {machineName && (
                  <span
                    className={
                      needYou
                        ? 'sr-only'
                        : `sr-only min-w-0 truncate font-normal text-muted-foreground @[13rem]:not-sr-only @[13rem]:overflow-hidden @[13rem]:whitespace-nowrap ${namesAgent ? 'max-w-[40%] shrink-0' : ''}`
                    }
                    title={machineName}
                  >
                    {machineName}
                  </span>
                )}
              </p>
            )}
            {offering && (
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                {t(
                  'auto.components.NativeChatResumeToast.promptsNotResent',
                  'Resuming won’t send your prompts again.'
                )}
              </p>
            )}
          </div>
          {offering && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {showResume && (
                <Button variant="theme-accent" size="xs" onClick={() => onResume(view.resumable)}>
                  {t('auto.components.NativeChatResumeToast.resume', 'Resume')}
                </Button>
              )}
              {detailsButton}
            </div>
          )}
        </div>
        {showRetry && (
          <Button variant="theme-accent" size="xs-compact" onClick={() => onResume(view.retryable)}>
            {t('auto.components.NativeChatResumeToast.retry', 'Retry')}
          </Button>
        )}
        {!offering && detailsButton}
        <Button
          variant="ghost"
          size="icon-xs"
          data-close-button
          onClick={onClose}
          aria-label={t('auto.components.NativeChatResumeToast.close', 'Close')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {showDetails && (
        <div id={listId} hidden={!expanded} className="border-t border-border">
          <div className="relative">
            <ul
              ref={listRef}
              aria-label={t('auto.components.NativeChatResumeToast.listLabel', 'Agents')}
              className="scrollbar-sleek max-h-64 overflow-y-auto p-1"
              onScroll={(event) => setMoreBelow(hasMoreBelow(event.currentTarget))}
            >
              {view.rows.map((row) => (
                <NativeChatResumeToastRow
                  key={row.candidate.sessionId}
                  row={row}
                  name={rowName(row)}
                  age={formatShortTimeAgo(row.candidate.recordedAt, listedAt)}
                  busy={busy}
                  remote={machineName !== undefined}
                  onAction={onRowAction}
                />
              ))}
            </ul>
            {/* The cap hides rows; a fade says the list goes on until it is scrolled to the end. */}
            {moreBelow && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-popover to-transparent" />
            )}
          </div>
          {(showDismissAll || view.startedBy === 'launch') && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {view.startedBy === 'launch' && (
                <span>
                  {t(
                    'auto.components.NativeChatResumeToast.resumedAutomatically',
                    'Resumed automatically.'
                  )}{' '}
                  <Button variant="link" size="inlineText" onClick={onOpenSettings}>
                    {t(
                      'auto.components.NativeChatResumeToast.changeInSettings',
                      'Change in Settings'
                    )}
                  </Button>
                </span>
              )}
              {showDismissAll && (
                <Button variant="link" size="inlineText" onClick={onDismissAll}>
                  {t('auto.components.NativeChatResumeToast.dismissAll', 'Dismiss all')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0]?.trim() ?? ''
}

function hasMoreBelow(list: HTMLElement): boolean {
  return list.scrollTop + list.clientHeight < list.scrollHeight - 2
}
