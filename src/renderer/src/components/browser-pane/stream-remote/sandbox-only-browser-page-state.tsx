import { Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/** Only http(s) pages can be reopened as a desktop-hosted tab; file:, about:, chrome: stay in the sandbox. */
export function canOpenSandboxPageOnThisComputer(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * A page the agent opened in the sandbox's headless browser, on a runtime that cannot stream it.
 * Replaces the stream viewport (and its "does not support remote browser streaming" notice).
 */
export function SandboxOnlyBrowserPageState({
  url,
  opening,
  error,
  onOpenOnThisComputer
}: {
  url: string
  opening: boolean
  error: string | null
  onOpenOnThisComputer: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const canOpen = canOpenSandboxPageOnThisComputer(url)
  return (
    <div
      data-testid="sandbox-only-browser-page"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <Globe className="size-5 text-muted-foreground" aria-hidden />
      <div className="text-sm font-medium text-foreground">
        {t(
          'auto.components.browser.pane.SandboxOnlyBrowserPage.title',
          'Your agent opened this page in the sandbox'
        )}
      </div>
      <div className="max-w-sm text-xs leading-5 text-muted-foreground">
        {t(
          'auto.components.browser.pane.SandboxOnlyBrowserPage.body',
          "Orca can't show the sandbox's browser here yet. Open the page on this computer to see it. Pages the agent signed in to will open signed out."
        )}
      </div>
      {canOpen ? (
        <Button size="sm" onClick={onOpenOnThisComputer} disabled={opening}>
          {t('auto.components.browser.pane.SandboxOnlyBrowserPage.open', 'Open on this computer')}
        </Button>
      ) : (
        <div className="max-w-sm text-xs leading-5 text-muted-foreground">
          {t(
            'auto.components.browser.pane.SandboxOnlyBrowserPage.sandboxOnly',
            'This page can only be viewed in the sandbox.'
          )}
        </div>
      )}
      {error ? (
        <div role="alert" className="max-w-sm text-xs leading-5 text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  )
}
