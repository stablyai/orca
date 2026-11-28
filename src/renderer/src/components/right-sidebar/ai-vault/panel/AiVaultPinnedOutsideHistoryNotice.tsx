import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'

export function AiVaultPinnedOutsideHistoryNotice({
  count,
  onLoadFullHistory
}: {
  count: number
  onLoadFullHistory: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center justify-between gap-2 border-b border-sidebar-border px-3 py-2 text-xs text-muted-foreground">
      <span>
        {t(
          'auto.components.right.sidebar.AiVaultPanel.pinnedOutsideHistory',
          '{{count}} pinned sessions are older than the loaded history',
          { count }
        )}
      </span>
      <Button variant="link" size="inlineText" onClick={onLoadFullHistory}>
        {t('auto.components.right.sidebar.AiVaultPanel.loadFullHistory', 'Load full history')}
      </Button>
    </div>
  )
}
