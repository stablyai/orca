import React from 'react'
import { Activity, ChevronRight, CircleX } from 'lucide-react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { cn } from '@/lib/class-names'
import type { SlotException, SlotSignal } from './worktree-card-slot-signal'
import type { SlotTarget } from './worktree-card-slot-targets'
import { SlotJumpTrigger } from './worktree-card-slot-jump'

function formatSlotTime(at: number | null, now: number): string {
  return at === null ? '' : formatShortTimeAgo(at, now)
}

export function slotLabel(signal: SlotSignal): string | undefined {
  switch (signal.kind) {
    case 'needs':
      return translate('sidebar.cardSlot.needsYouLabel', 'Waiting on you')
    case 'failed':
      return translate('sidebar.cardSlot.failedLabel', 'Last turn failed')
    case 'unread':
      return signal.manual
        ? translate('sidebar.cardSlot.markedUnread', 'Marked unread by you')
        : translate('sidebar.cardSlot.unread', 'Unread result')
    case 'working':
      return signal.monitoring
        ? translate('sidebar.cardSlot.monitoring', 'Monitoring')
        : translate('sidebar.cardSlot.working', 'Working')
    case 'offline':
      return translate('sidebar.cardSlot.offlineLabel', 'Host offline')
    case 'time':
    case 'quiet':
      return undefined
  }
}

/** The one status slot at a row's right edge: the first exception, otherwise the time. */
export function WorktreeCardSlot({
  signal,
  now,
  stale = false,
  timeTone
}: {
  signal: SlotSignal
  now: number
  /** The host is offline: show what was last seen, never a live state. */
  stale?: boolean
  /** A plain time beside an unread or working glyph reads like that state's own time. */
  timeTone?: 'unread' | 'working'
}): React.JSX.Element | null {
  if (signal.kind === 'quiet') {
    return null
  }
  const base =
    'inline-flex min-w-[22px] shrink-0 items-center justify-end gap-1 whitespace-nowrap text-3xs leading-none tabular-nums'
  const label = slotLabel(signal)
  const slotProps = { 'data-worktree-card-slot': signal.kind, title: label }

  if (stale || signal.kind === 'offline') {
    return (
      <span {...slotProps} className={cn(base, 'italic text-muted-foreground/70')}>
        {signal.kind === 'offline'
          ? translate('sidebar.cardSlot.offline', 'offline')
          : 'at' in signal
            ? formatSlotTime(signal.at, now)
            : null}
      </span>
    )
  }

  switch (signal.kind) {
    case 'needs':
      return <WorktreeCardStatusPill signal={signal} />
    case 'failed':
      return (
        <span {...slotProps} className={cn(base, 'font-semibold text-destructive')}>
          {/* A crossed circle, not a red dot, so failed never reads like the blue unread dot. */}
          <CircleX className="size-2.5 shrink-0" aria-hidden="true" />
          {translate('sidebar.cardSlot.failed', 'Failed')}
        </span>
      )
    case 'unread':
      return (
        <span {...slotProps} className={cn(base, 'font-medium text-foreground')}>
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-unread" />
          {formatSlotTime(signal.at, now)}
        </span>
      )
    case 'working':
      return (
        <span {...slotProps} className={cn(base, 'text-muted-foreground')}>
          {signal.monitoring ? (
            <Activity className="size-2.5 shrink-0 text-agent-working" aria-hidden="true" />
          ) : (
            <AgentWorkingSpinner className="size-[9px] border-[1.5px]" />
          )}
          {formatSlotTime(signal.at, now)}
        </span>
      )
    case 'time':
      return (
        <span
          {...slotProps}
          className={cn(
            base,
            timeTone === 'unread'
              ? 'font-medium text-foreground'
              : timeTone === 'working'
                ? 'text-muted-foreground'
                : 'text-muted-foreground/70'
          )}
        >
          {formatSlotTime(signal.at, now)}
        </span>
      )
  }
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
  return (
    <span
      data-worktree-card-slot={signal.kind}
      title={slotLabel(signal)}
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
        ? translate('sidebar.cardSlot.failed', 'Failed')
        : signal.count > 1
          ? translate('sidebar.cardSlot.needYouCount', '{{count}} need you', {
              count: signal.count
            })
          : translate('sidebar.cardSlot.needsYou', 'Needs you')}
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
          label={slotLabel(pill) ?? ''}
          resolveTargets={() => resolveTargets(pill.kind)}
          className="-my-0.5 inline-flex min-w-0 items-center"
        >
          <WorktreeCardStatusPill signal={pill} />
        </SlotJumpTrigger>
      ))}
    </>
  )
}

export type TitleTimeToggle = {
  open: boolean
  label: string
  disabled: boolean
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
  onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void
}

/**
 * The time. On a card that opens it is also the open/close button: hover or keyboard focus
 * shows the chevron in its place, and a tap on the time works where there is no hover.
 */
export function WorktreeCardTitleTime({
  exceptions,
  at,
  now,
  toggle,
  disclosureOnly = false
}: {
  exceptions: readonly SlotException[]
  at: number | null
  now: number
  toggle: TitleTimeToggle | null
  disclosureOnly?: boolean
}): React.JSX.Element {
  const time = (
    <WorktreeCardSlot
      signal={{ kind: 'time', at }}
      now={now}
      timeTone={titleTimeTone(exceptions)}
    />
  )
  if (toggle === null) {
    return time
  }
  return (
    <button
      type="button"
      className="group/title-time -my-0.5 inline-grid h-4 min-w-4 shrink-0 cursor-pointer items-center justify-items-end rounded-sm leading-none text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none"
      aria-label={toggle.label}
      aria-expanded={toggle.open}
      disabled={toggle.disabled}
      onPointerDown={toggle.onPointerDown}
      onClick={(event) => {
        event.stopPropagation()
        toggle.onToggle(event)
      }}
    >
      <span
        className={cn(
          '[grid-area:1/1] inline-flex items-center can-hover:group-hover/worktree-card:invisible group-focus-visible/title-time:invisible',
          disclosureOnly && 'invisible'
        )}
      >
        {time}
      </span>
      <span
        className={cn(
          '[grid-area:1/1] inline-flex size-4 items-center justify-center can-hover:group-hover/worktree-card:visible group-focus-visible/title-time:visible',
          !disclosureOnly && 'invisible'
        )}
      >
        <ChevronRight
          className={cn(
            'size-3 transition-transform motion-reduce:transition-none',
            toggle.open && 'rotate-90'
          )}
          aria-hidden
        />
      </span>
    </button>
  )
}
