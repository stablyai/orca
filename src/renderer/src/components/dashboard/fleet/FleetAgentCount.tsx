import { useTranslate } from '@/i18n/use-translate'

export function FleetAgentCount({ count }: { count: number }): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="shrink-0 text-2xs text-muted-foreground">
      {t('dashboardPopout.fleet.agentCount', '{{count}} agents', {
        count,
        defaultValue_one: '{{count}} agent'
      })}
    </span>
  )
}
