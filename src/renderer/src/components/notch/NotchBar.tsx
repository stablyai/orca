import { Check, Circle, CircleAlert } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import type { NotchLane } from '../../../../shared/notch/notch-status-summary'
import type { NotchSnapshot } from '../../../../shared/notch/notch-snapshot'

const LANE_CLASS: Record<NotchLane, string> = {
  working: 'text-foreground',
  attention: 'text-destructive',
  done: 'text-status-success'
}

function LaneIndicator({ lane, count }: { lane: NotchLane; count: number }): React.JSX.Element {
  const t = useTranslate()
  const labels = {
    working: t('notch.status.working', '{{count}} working', { count }),
    attention: t('notch.status.attention', '{{count}} awaiting input', { count }),
    done: t('notch.status.done', '{{count}} finished', { count })
  }
  const Icon = lane === 'done' ? Check : CircleAlert
  return (
    <span
      className={`flex items-center gap-1 text-2xs tabular-nums ${LANE_CLASS[lane]}`}
      role="status"
      aria-label={labels[lane]}
    >
      {lane === 'working' ? (
        <LoadingSpinner className="size-3" />
      ) : (
        <Icon aria-hidden="true" className="size-3" />
      )}
      <span aria-hidden="true" className="font-medium">
        {count > 99 ? '99+' : count}
      </span>
    </span>
  )
}

function Wing({
  lanes,
  counts,
  width,
  idle
}: {
  lanes: NotchLane[]
  counts: Record<NotchLane, number>
  width: number
  idle: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex h-full shrink-0 items-center justify-center gap-1.5" style={{ width }}>
      {idle ? (
        <span role="status" aria-label={t('notch.status.idle', 'No agents running')}>
          <Circle aria-hidden="true" className="size-3 text-muted-foreground" />
        </span>
      ) : (
        lanes.map((lane) => <LaneIndicator key={lane} lane={lane} count={counts[lane]} />)
      )}
    </div>
  )
}

export function NotchBar({ snapshot }: { snapshot: NotchSnapshot }): React.JSX.Element {
  const { layout, metrics, counts } = snapshot
  return (
    <div
      className="flex shrink-0 items-center rounded-b-xl bg-black text-foreground"
      style={{
        width: layout.barWidth,
        height: metrics.barHeight,
        borderTopLeftRadius: metrics.presentation === 'notch' ? 0 : 'var(--radius-xl)',
        borderTopRightRadius: metrics.presentation === 'notch' ? 0 : 'var(--radius-xl)'
      }}
    >
      <Wing
        lanes={layout.leftLanes}
        counts={counts}
        width={layout.wings.left}
        idle={layout.showsIdleMark}
      />
      <div className="h-full shrink-0" style={{ width: metrics.notchWidth }} aria-hidden="true" />
      <Wing lanes={layout.rightLanes} counts={counts} width={layout.wings.right} idle={false} />
    </div>
  )
}
