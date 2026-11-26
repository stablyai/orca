import type React from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function UpdateStatusDetails({ text }: { text: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-2 ms-10 flex items-start gap-1 rounded-md bg-muted/50 py-1.5 ps-2.5 pe-1">
      <pre
        role="region"
        aria-label={t('settings.about.status.details', 'Details')}
        tabIndex={0}
        className="max-h-24 min-w-0 flex-1 overflow-auto whitespace-pre py-0.5 font-mono text-xs text-muted-foreground scrollbar-sleek"
      >
        {text}
      </pre>
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-xs"
        aria-label={t('settings.about.status.copyDetails', 'Copy details')}
        onClick={() => {
          void window.api.ui.writeClipboardText(text).then(
            () => toast.message(t('settings.about.status.copied', 'Copied')),
            () => toast.error(t('settings.about.status.copyFailed', 'Could not copy details.'))
          )
        }}
      >
        <Copy />
      </Button>
    </div>
  )
}
