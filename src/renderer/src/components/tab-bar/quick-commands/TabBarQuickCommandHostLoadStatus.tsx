import { useTranslate } from '@/i18n/use-translate'

export function TabBarQuickCommandHostLoadStatus({
  failed
}: {
  failed: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
      {failed
        ? t(
            'auto.components.tab.bar.TabBarQuickCommandHostLoadStatus.82e294f3ca',
            'Host unavailable'
          )
        : t('auto.components.tab.bar.TabBarQuickCommandHostLoadStatus.7c129b08ff', 'Loading host…')}
    </div>
  )
}
