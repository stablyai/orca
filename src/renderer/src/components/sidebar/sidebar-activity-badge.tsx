import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export function SidebarActivityBadge({
  counts
}: {
  counts: { attention: number; working: number }
}): React.JSX.Element {
  const t = useTranslate()
  const activityCount = counts.attention || counts.working
  const activityStatusLabel = counts.attention
    ? t('dashboardPopout.bucket.attention', 'Needs You')
    : counts.working
      ? t('dashboardPopout.bucket.working', 'Working')
      : t('dashboardPopout.bucket.idle', 'Idle')
  return (
    <span
      className="pointer-events-none absolute inset-0"
      aria-label={`${activityStatusLabel}: ${activityCount}`}
    >
      <span className="absolute right-0 top-0 flex h-2 w-3 items-center justify-center">
        {counts.attention > 0 ? (
          <AgentQuestionIcon className="size-2" />
        ) : (
          <span
            className={cn(
              'size-1 rounded-full',
              counts.working > 0 ? 'bg-(--status-warning)' : 'bg-muted-foreground'
            )}
          />
        )}
      </span>
      <span className="absolute right-0 top-2.5 flex h-2.5 w-3 items-center justify-center">
        <span
          className={cn('icon-superscript-count', activityCount > 99 && 'origin-center scale-x-65')}
          data-multiple-digits={activityCount > 9}
        >
          {activityCount > 99 ? '99+' : activityCount}
        </span>
      </span>
    </span>
  )
}
