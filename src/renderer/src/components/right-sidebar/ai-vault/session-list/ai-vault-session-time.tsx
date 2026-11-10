import type React from 'react'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useNow } from '@/hooks/use-now'
import { recomputeOn } from '@/lib/recompute-on'

export function SessionTime({
  value,
  className
}: {
  value: string
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  // Rows are memoized, so the label ages on the shared minute tick rather than on parent renders.
  const now = useNow(60_000)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return (
      <span className={cn('shrink-0 text-[11px] text-muted-foreground', className)}>
        {t('auto.components.right.sidebar.AiVaultSessionDetails.unknownTime', 'Unknown time')}
      </span>
    )
  }

  const date = new Date(timestamp)
  return (
    <span className={cn('shrink-0 text-[11px] text-muted-foreground', className)}>
      <time dateTime={date.toISOString()}>
        {recomputeOn([now], () => formatTimeAgo(timestamp, t))}
      </time>
    </span>
  )
}

export function formatTimeAgo(timestamp: number, t: Translate = translate): string {
  const diffMs = Date.now() - timestamp
  if (diffMs < 60_000) {
    return t('auto.components.right.sidebar.AiVaultSessionDetails.justNow', 'Just now')
  }
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) {
    return t('auto.components.right.sidebar.AiVaultSessionDetails.minutesAgo', '{{value0}}m ago', {
      value0: minutes
    })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return t('auto.components.right.sidebar.AiVaultSessionDetails.hoursAgo', '{{value0}}h ago', {
      value0: hours
    })
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return t('auto.components.right.sidebar.AiVaultSessionDetails.daysAgo', '{{value0}}d ago', {
      value0: days
    })
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    return t('auto.components.right.sidebar.AiVaultSessionDetails.monthsAgo', '{{value0}}mo ago', {
      value0: months
    })
  }
  return t('auto.components.right.sidebar.AiVaultSessionDetails.yearsAgo', '{{value0}}y ago', {
    value0: Math.floor(months / 12)
  })
}
