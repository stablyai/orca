import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import type { ResumeFailureAction } from '../failures/native-chat-resume-failure-guidance'
import type { ResumeToastView } from './native-chat-resume-toast-view'
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
  /** Local only: deletes the durable offer. A server's chats can only be hidden by closing. */
  onDismissAll?: () => void
  onClose: () => void
}

function headline(view: ResumeToastView, t: Translate, machineName?: string): string {
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
  return view.counts.needsYou > 0 ? (
    <AlertCircle className="size-4 shrink-0 text-status-warning" />
  ) : (
    <RotateCcw className="size-4 shrink-0 text-muted-foreground" />
  )
}

/** The chats a restart left for the person: one line, a Resume, chats behind Details. */
export function NativeChatResumeToast({
  view,
  machineName,
  listedAt,
  nameFor,
  defaultExpanded = false,
  onResume,
  onRowAction,
  onDismissAll,
  onClose
}: NativeChatResumeToastProps): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const titleId = useId()
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const [moreBelow, setMoreBelow] = useState(false)
  const rowCount = view.rows.length
  useEffect(() => {
    if (expanded && listRef.current) {
      setMoreBelow(hasMoreBelow(listRef.current))
    }
  }, [expanded, rowCount])
  const showResume = view.resumable.length > 0
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
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {t(
                'auto.components.NativeChatResumeToast.promptsNotResent',
                'Resuming won’t send your prompts again.'
              )}
            </p>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {showResume && (
              <Button size="xs" onClick={() => onResume(view.resumable)}>
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
              onClick={() => setExpanded(!expanded)}
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
                  row.candidate.sessionId,
                  firstLine(row.candidate.latestPrompt) ||
                    t('auto.components.NativeChatResumeToast.untitled', 'Untitled agent')
                )}
                age={formatShortTimeAgo(row.candidate.recordedAt, listedAt)}
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
            {t(
              'auto.components.NativeChatResumeToast.willAsk',
              'Orca asks agents to continue. Queued messages may be sent.'
            )}
          </p>
          {onDismissAll && (
            <Button variant="link" size="inlineText" onClick={onDismissAll}>
              {t('auto.components.NativeChatResumeToast.dismissAll', 'Dismiss all')}
            </Button>
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
