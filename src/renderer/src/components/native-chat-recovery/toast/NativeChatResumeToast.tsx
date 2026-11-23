import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import type { ResumeFailureAction } from '../failures/native-chat-resume-failure-guidance'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import type { ResumeToastView } from './native-chat-resume-toast-view'
import { NativeChatResumeToastRow } from './NativeChatResumeToastRow'

export type NativeChatResumeToastProps = {
  view: ResumeToastView
  /** Set for a paired server; its chats are named with the machine. */
  machineName?: string
  listedAt: number
  nameFor: (candidate: ResumeCandidate, fallback: string) => string
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

function headline(view: ResumeToastView, t: Translate, machineName?: string): string {
  const { phase, counts } = view
  if (phase === 'resuming') {
    return machineName
      ? t(
          'auto.components.NativeChatResumeToast.resumingOn',
          'Resuming {{count}} agents on {{machine}}…',
          {
            count: counts.resuming,
            machine: machineName,
            defaultValue_one: 'Resuming {{count}} agent on {{machine}}…'
          }
        )
      : t('auto.components.NativeChatResumeToast.resuming', 'Resuming {{count}} agents…', {
          count: counts.resuming,
          defaultValue_one: 'Resuming {{count}} agent…'
        })
  }
  if (phase === 'finished' && counts.needsYou === 0) {
    if (machineName) {
      return t(
        'auto.components.NativeChatResumeToast.resumedOn',
        'Resumed {{count}} agents on {{machine}}.',
        {
          count: counts.resumed,
          machine: machineName,
          defaultValue_one: 'Resumed {{count}} agent on {{machine}}.'
        }
      )
    }
    return view.interruptedByUpdate
      ? t(
          'auto.components.NativeChatResumeToast.resumedUpdate',
          'Resumed {{count}} agents after the update.',
          {
            count: counts.resumed,
            defaultValue_one: 'Resumed {{count}} agent after the update.'
          }
        )
      : t(
          'auto.components.NativeChatResumeToast.resumedRestart',
          'Resumed {{count}} agents after the restart.',
          {
            count: counts.resumed,
            defaultValue_one: 'Resumed {{count}} agent after the restart.'
          }
        )
  }
  if (phase === 'finished' && counts.resumed > 0) {
    const text = t(
      'auto.components.NativeChatResumeToast.partial',
      'Resumed {{resumed}} of {{total}} agents. {{count}} need you.',
      {
        resumed: counts.resumed,
        total: counts.total,
        count: counts.needsYou,
        defaultValue_one: 'Resumed {{resumed}} of {{total}} agents. {{count}} needs you.'
      }
    )
    return machineName ? `${machineName}: ${text}` : text
  }
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

/** The resume-on-restart report: one line, a Resume when nothing was sent, chats behind Details. */
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
  const offering = view.phase === 'offer'
  const showResume = offering && view.resumable.length > 0
  const showDismissAll = onDismissAll !== undefined && offering
  return (
    <section
      aria-labelledby={titleId}
      className="w-full overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-floating"
    >
      <div className="flex min-w-0 items-start gap-2.5 py-2.5 pr-2 pl-3.5">
        <span className="mt-0.5 inline-flex">
          <HeadlineIcon view={view} />
        </span>
        <div className="min-w-0 flex-1">
          {/* The status line is what changes, so it alone is announced. */}
          <div role="status">
            <p
              id={titleId}
              className="text-[13px] leading-snug font-medium break-keep [overflow-wrap:anywhere]"
            >
              {headline(view, t, machineName)}
            </p>
            {offering && (
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                {t(
                  'auto.components.NativeChatResumeToast.promptsNotResent',
                  'Resuming won’t send your prompts again.'
                )}
              </p>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {showResume && (
              <Button variant="theme-accent" size="xs" onClick={() => onResume(view.resumable)}>
                {t('auto.components.NativeChatResumeToast.resume', 'Resume')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              // Alone, it lines up with the text above rather than its own padding.
              className={showResume ? undefined : '-ml-2'}
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
          </div>
        </div>
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
                name={nameFor(
                  row.candidate,
                  firstLine(row.candidate.latestPrompt) ||
                    t('auto.components.NativeChatResumeToast.untitled', 'Untitled agent')
                )}
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
        <div className="space-y-1.5 border-t border-border px-3.5 py-2.5 text-xs text-muted-foreground">
          {/* Balanced, so a longer locale wraps into even lines instead of orphaning a word; CJK breaks only between phrases. */}
          <p className="text-balance break-keep">
            {offering
              ? t(
                  'auto.components.NativeChatResumeToast.willAsk',
                  'Orca asks agents to continue. Queued messages may be sent.'
                )
              : t(
                  'auto.components.NativeChatResumeToast.asked',
                  'Orca asked agents to continue. Queued messages may be sent.'
                )}
          </p>
          {(showDismissAll || view.startedBy === 'launch') && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
      </div>
    </section>
  )
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0]?.trim() ?? ''
}

function hasMoreBelow(list: HTMLElement): boolean {
  return list.scrollTop + list.clientHeight < list.scrollHeight - 2
}
