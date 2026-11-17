import { useTranslate } from '@/i18n/use-translate'

export function SshTargetsEmptyState(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
      {t('auto.components.settings.SshPane.c0f1c80166', 'No SSH targets configured.')}
    </div>
  )
}
