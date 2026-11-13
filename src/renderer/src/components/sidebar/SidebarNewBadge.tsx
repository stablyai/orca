import { useTranslate } from '@/i18n/use-translate'
export function SidebarNewBadge(): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="shrink-0 rounded-full bg-primary px-1.5 py-px text-3xs font-semibold text-primary-foreground">
      {t('sidebar.new', 'New')}
    </span>
  )
}
