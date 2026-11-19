import type { Dispatch, SetStateAction } from 'react'
import { useTranslate } from '@/i18n/use-translate'

/** Page notices under the toolbar. Annotate, Grab and Draw status lives in the palette over the page. */
export function BrowserPageChromeBanners({
  resourceNotice,
  setResourceNotice
}: {
  resourceNotice: string | null
  setResourceNotice: Dispatch<SetStateAction<string | null>>
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!resourceNotice) {
    return null
  }
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-background px-3 py-1.5 text-xs text-muted-foreground">
      <span>{resourceNotice}</span>
      <button
        type="button"
        onClick={() => setResourceNotice(null)}
        className="shrink-0 text-muted-foreground/60 hover:text-foreground"
        aria-label={t('auto.components.browser.pane.BrowserPane.2fdca7df09', 'Dismiss')}
      >
        ✕
      </button>
    </div>
  )
}
