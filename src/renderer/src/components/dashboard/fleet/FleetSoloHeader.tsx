import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export function FleetSoloHeader({
  count,
  className
}: {
  count: number
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <header className={cn('flex items-center gap-2', className)}>
      <h3 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
        {t('dashboard.fleet.solo.title', 'Independent agents')}
      </h3>
      <span className="rounded-full bg-background px-1.5 text-2xs tabular-nums text-muted-foreground">
        {count}
      </span>
    </header>
  )
}
