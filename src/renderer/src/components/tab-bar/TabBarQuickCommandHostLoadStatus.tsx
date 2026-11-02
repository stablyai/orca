import { translate } from '@/i18n/i18n'

export function TabBarQuickCommandHostLoadStatus({
  failed
}: {
  failed: boolean
}): React.JSX.Element {
  return (
    <div className="border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
      {failed
        ? translate(
            'auto.components.tab.bar.TabBarQuickCommandHostLoadStatus.82e294f3ca',
            'Host unavailable'
          )
        : translate(
            'auto.components.tab.bar.TabBarQuickCommandHostLoadStatus.7c129b08ff',
            'Loading host…'
          )}
    </div>
  )
}
