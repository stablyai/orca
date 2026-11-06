import React from 'react'
import { Activity, CircleX } from 'lucide-react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { cn } from '@/lib/utils'
import type { SlotSignal } from './worktree-card-slot-signal'

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
  compact = false
}: {
  signal: SlotSignal
  now: number
  /** The host is offline: show what was last seen, never a live state. */
  stale?: boolean
  /** Title row: needs/failed as a glyph so long names keep their width; the clickable parent labels it. */
  compact?: boolean
}): React.JSX.Element | null {
  if (signal.kind === 'quiet') {
    return null
  }
  const base =
    'inline-flex min-w-[22px] shrink-0 items-center justify-end gap-1 whitespace-nowrap text-3xs leading-none tabular-nums'
  const label = slotLabel(signal)
  // A compact exception sits inside a labelled button; offline and times keep their tooltip.
  const labelledByParent =
    compact &&
    !stale &&
    (signal.kind === 'needs' ||
      signal.kind === 'failed' ||
      signal.kind === 'unread' ||
      signal.kind === 'working')
  const slotProps = {
    'data-worktree-card-slot': signal.kind,
    title: labelledByParent ? undefined : label
  }

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
      if (compact) {
        return (
          <span {...slotProps} className={cn(base, 'font-semibold text-agent-question-text')}>
            <AgentQuestionIcon className="size-2.5 shrink-0" />
            {signal.count > 1 ? signal.count : null}
          </span>
        )
      }
      return (
        <span
          {...slotProps}
          className={cn(
            base,
            'h-4 rounded-[5px] bg-agent-question/15 px-1.5 font-semibold text-agent-question-text'
          )}
        >
          {/* Same question glyph tabs, the dashboard and kanban use for an agent waiting on you. */}
          <AgentQuestionIcon className="size-2.5 shrink-0" />
          {signal.count > 1
            ? translate('sidebar.cardSlot.needYouCount', '{{count}} need you', {
                count: signal.count
              })
            : translate('sidebar.cardSlot.needsYou', 'Needs you')}
        </span>
      )
    case 'failed':
      if (compact) {
        return (
          <span {...slotProps} className={cn(base, 'text-destructive')}>
            <CircleX className="size-2.5 shrink-0" aria-hidden="true" />
          </span>
        )
      }
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
        <span {...slotProps} className={cn(base, 'text-muted-foreground/70')}>
          {formatSlotTime(signal.at, now)}
        </span>
      )
  }
}
