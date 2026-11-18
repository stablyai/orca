import { useTranslate } from '@/i18n/use-translate'

export function FleetSoloHeader({ count }: { count: number }): React.JSX.Element {
  const t = useTranslate()
  return (
    <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <h3 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
        {t('dashboardPopout.fleet.solo.title', 'Independent agents')}
      </h3>
      <span className="rounded-full bg-background px-1.5 text-2xs tabular-nums text-muted-foreground">
        {count}
      </span>
    </header>
  )
}
