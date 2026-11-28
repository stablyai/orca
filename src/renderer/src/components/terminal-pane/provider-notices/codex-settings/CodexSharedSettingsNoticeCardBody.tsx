import { Info, X } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../ui/card'
import { Button } from '../../../ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function CodexSharedSettingsNoticeCardBody({
  onDismiss
}: {
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Card role="complementary" aria-labelledby="codex-shared-settings-notice-heading">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Info className="size-4 text-muted-foreground" />
            <CardTitle id="codex-shared-settings-notice-heading">
              {t('terminal.codexSharedSettingsNotice.title', 'Codex in Orca now uses ~/.codex')}
            </CardTitle>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDismiss}
            aria-label={t('terminal.codexSharedSettingsNotice.dismiss', 'Dismiss')}
          >
            <X />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <CardDescription>
          {t(
            'terminal.codexSharedSettingsNotice.description',
            'Codex may ask again to trust folders or approve commands. Re-add any MCP servers you added only in Orca.'
          )}
        </CardDescription>
      </CardContent>
    </Card>
  )
}
