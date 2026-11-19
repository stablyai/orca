import type { Dispatch, SetStateAction } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { BrowserGuestGrabBanner } from '../../annotate/browser-guest-grab-banner'
import type { useBrowserGuestAnnotateTools } from '../../annotate/use-browser-guest-annotate-tools'

export function BrowserPageChromeBanners({
  resourceNotice,
  setResourceNotice,
  tools,
  worktreeId,
  showGrabBanner = true
}: {
  resourceNotice: string | null
  setResourceNotice: Dispatch<SetStateAction<string | null>>
  tools: Pick<
    ReturnType<typeof useBrowserGuestAnnotateTools>,
    'grab' | 'grabAnnotations' | 'annotationSend'
  >
  worktreeId: string
  showGrabBanner?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {resourceNotice ? (
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
      ) : null}
      {showGrabBanner ? <BrowserGuestGrabBanner tools={tools} worktreeId={worktreeId} /> : null}
    </>
  )
}
