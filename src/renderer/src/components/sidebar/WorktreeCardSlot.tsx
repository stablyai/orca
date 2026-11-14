import React from 'react'
import { CircleX } from 'lucide-react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { cn } from '@/lib/class-names'
import type { SlotException, SlotSignal } from './worktree-card-slot-signal'
import type { SlotTarget } from './worktree-card-slot-targets'
import { SlotJumpTrigger } from './worktree-card-slot-jump'

function formatSlotTime(at: number | null, now: number): string {
  return at === null ? '' : formatShortTimeAgo(at, now)
}

function slotLabel(signal: SlotSignal, t: Translate): string | undefined {
  switch (signal.kind) {
    case 'needs':
      return t('sidebar.cardSlot.needsYouLabel', 'Waiting on you')
    case 'failed':
      return t('sidebar.cardSlot.failedLabel', 'Last turn failed')
    case 'unread':
      return signal.manual
        ? t('sidebar.cardSlot.markedUnread', 'Marked unread by you')
        : t('sidebar.cardSlot.unread', 'Unread result')
    case 'working':
      return signal.monitoring
        ? t('sidebar.cardSlot.monitoring', 'Monitoring')
        : t('sidebar.cardSlot.working', 'Working')
    case 'offline':
      return t('sidebar.cardSlot.offlineLabel', 'Host offline')
    case 'time':
    case 'quiet':
      return undefined
  }
}

/** The title's time, or its host's offline state. */
export function WorktreeCardSlot({
  signal,
  now,
  timeTone
}: {
  signal: Extract<SlotSignal, { kind: 'time' } | { kind: 'offline' }>
  now: number
  timeTone?: 'unread' | 'working'
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span
      data-worktree-card-slot={signal.kind}
      title={slotLabel(signal, t)}
      className={cn(
        'inline-flex min-w-[22px] shrink-0 items-center justify-end whitespace-nowrap text-3xs leading-none tabular-nums',
        signal.kind === 'offline'
          ? 'italic text-muted-foreground/70'
          : timeTone === 'unread'
            ? 'font-medium text-foreground'
            : timeTone === 'working'
              ? 'text-muted-foreground'
              : 'text-muted-foreground/70'
      )}
    >
      {signal.kind === 'offline'
        ? t('sidebar.cardSlot.offline', 'offline')
        : formatSlotTime(signal.at, now)}
    </span>
  )
}

function titleTimeTone(exceptions: readonly SlotException[]): 'unread' | 'working' | undefined {
  if (exceptions.some((exception) => exception.kind === 'unread')) {
    return 'unread'
  }
  return exceptions.some((exception) => exception.kind === 'working') ? 'working' : undefined
}

type PillSignal = Extract<SlotSignal, { kind: 'needs' } | { kind: 'failed' }>

/** The loud statuses get a labelled pill, so a card that needs you is hard to miss. */
export function WorktreeCardStatusPill({ signal }: { signal: PillSignal }): React.JSX.Element {
  const t = useTranslate()
  return (
    <span
      data-worktree-card-slot={signal.kind}
      title={slotLabel(signal, t)}
      className={cn(
        'inline-flex h-4 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 text-3xs leading-none font-semibold',
        signal.kind === 'needs'
          ? 'bg-agent-question/15 text-agent-question-text'
          : 'bg-destructive/15 text-destructive'
      )}
    >
      {signal.kind === 'needs' ? (
        // Same question glyph tabs, the dashboard and kanban use for an agent waiting on you.
        <AgentQuestionIcon className="size-2.5 shrink-0" />
      ) : (
        // A crossed circle, not a red dot, so failed never reads like the blue unread dot.
        <CircleX className="size-2.5 shrink-0" aria-hidden="true" />
      )}
      {signal.kind === 'failed'
        ? t('sidebar.cardSlot.failed', 'Failed')
        : signal.count > 1
          ? t('sidebar.cardSlot.needYouCount', '{{count}} need you', {
              count: signal.count
            })
          : t('sidebar.cardSlot.needsYou', 'Needs you')}
    </span>
  )
}

/** Title row: a labelled pill per loud status, each opening its sources. */
export function WorktreeCardTitlePills({
  exceptions,
  resolveTargets
}: {
  exceptions: readonly SlotException[]
  resolveTargets: (kind: SlotException['kind']) => SlotTarget[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const pills = exceptions.filter(
    (exception): exception is PillSignal =>
      exception.kind === 'needs' || exception.kind === 'failed'
  )
  if (pills.length === 0) {
    return null
  }
  return (
    <>
      {pills.map((pill) => (
        <SlotJumpTrigger
          key={pill.kind}
          label={slotLabel(pill, t) ?? ''}
          resolveTargets={() => resolveTargets(pill.kind)}
          className="-my-0.5 inline-flex min-w-0 items-center"
        >
          <WorktreeCardStatusPill signal={pill} />
        </SlotJumpTrigger>
      ))}
    </>
  )
}

export function WorktreeCardTitleTime({
  exceptions,
  at,
  now
}: {
  exceptions: readonly SlotException[]
  at: number | null
  now: number
}): React.JSX.Element {
  return (
    <WorktreeCardSlot
      signal={{ kind: 'time', at }}
      now={now}
      timeTone={titleTimeTone(exceptions)}
    />
  )
}
