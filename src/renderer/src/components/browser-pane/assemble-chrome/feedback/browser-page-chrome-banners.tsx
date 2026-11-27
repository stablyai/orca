import { CircleCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { BrowserGuestGrabBanner } from '../../annotate/browser-guest-grab-banner'
import type { useBrowserGuestAnnotateTools } from '../../annotate/use-browser-guest-annotate-tools'
import type { BrowserResourceNotice } from '../../navigate/use-browser-page-resource-notices'

const COUNT_FORMAT: Intl.NumberFormatOptions = {}

export function CookiesImportedBanner({
  count,
  onReloadPage,
  onDismiss
}: {
  count: number
  onReloadPage: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const countLabel = uiNumberFormat(COUNT_FORMAT, intlLocale).format(count)
  const message = t(
    'browser.cookieImport.notice.importedCount',
    'Imported {{countLabel}} cookies',
    {
      count,
      countLabel,
      defaultValue_one: 'Imported {{countLabel}} cookie'
    }
  )
  return (
    // Why pl-3/pr-2: the check centers on the toolbar's back button, the × on its close button.
    <div className="flex min-h-9 items-center gap-2 border-b border-border/60 bg-background pl-3 pr-2 text-[13px] text-foreground">
      <CircleCheck className="size-4 shrink-0 text-status-success" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={message}>
        {message}
      </span>
      <Button
        size="xs-notice"
        className="shrink-0"
        onClick={() => {
          onReloadPage()
          onDismiss()
        }}
      >
        {t('browser.cookieImport.notice.reload', 'Reload')}
      </Button>
      <Button
        size="icon-xs"
        variant="muted-field-icon"
        className="shrink-0"
        onClick={onDismiss}
        aria-label={t('auto.components.browser.pane.BrowserPane.2fdca7df09', 'Dismiss')}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

export function BrowserPageChromeBanners({
  resourceNotice,
  setResourceNotice,
  onReloadPage,
  tools,
  worktreeId,
  showGrabBanner = true
}: {
  resourceNotice: BrowserResourceNotice | null
  setResourceNotice: (notice: string | null) => void
  onReloadPage: () => void
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
      {resourceNotice?.kind === 'cookies-imported' ? (
        <CookiesImportedBanner
          count={resourceNotice.count}
          onReloadPage={onReloadPage}
          onDismiss={() => setResourceNotice(null)}
        />
      ) : resourceNotice ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-background px-3 py-1.5 text-xs text-muted-foreground">
          <span>{resourceNotice.text}</span>
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
