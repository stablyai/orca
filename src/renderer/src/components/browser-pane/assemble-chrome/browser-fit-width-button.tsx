import { useEffect, useState } from 'react'
import { MoveHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserPageZoomDirection } from '../../../../../shared/browser-page-zoom'
import type { BrowserPageSiteDisplay } from '../../../../../shared/browser-site-display'

const FIT_WIDTH_CHANGED_EVENT = 'orca:browser-site-fit-width-changed'

/** Fit-width is per site, so every toolbar showing that site must refresh after any toggle. */
export async function setBrowserPageFitWidth(
  browserPageId: string,
  fitWidth: boolean
): Promise<BrowserPageSiteDisplay | null> {
  const display = await window.api.browser.setPageSiteFitWidth({ browserPageId, fitWidth })
  window.dispatchEvent(new Event(FIT_WIDTH_CHANGED_EVENT))
  return display
}

/** Zoom steps can stop at or leave fit-width, so toolbars refresh as after a toggle. */
export async function zoomBrowserPage(
  browserPageId: string,
  direction: BrowserPageZoomDirection
): Promise<BrowserPageSiteDisplay | null> {
  const display = await window.api.browser.zoomPage({ browserPageId, direction })
  window.dispatchEvent(new Event(FIT_WIDTH_CHANGED_EVENT))
  return display
}

export function BrowserFitWidthButton({
  browserPageId,
  pageKey
}: {
  browserPageId: string
  /** Changes on navigation and load, when the page's site can change. */
  pageKey: string
}): React.JSX.Element {
  const t = useTranslate()
  const [display, setDisplay] = useState<BrowserPageSiteDisplay | null>(null)

  useEffect(() => {
    let current = true
    const refresh = (): void => {
      void window.api.browser.getPageSiteDisplay({ browserPageId }).then((next) => {
        if (current) {
          setDisplay(next)
        }
      })
    }
    refresh()
    window.addEventListener(FIT_WIDTH_CHANGED_EVENT, refresh)
    return () => {
      current = false
      window.removeEventListener(FIT_WIDTH_CHANGED_EVENT, refresh)
    }
  }, [browserPageId, pageKey])

  const active = display?.fitWidth === true
  const label = t('auto.components.browser.pane.BrowserToolbarMenu.fitWidth', 'Fit to Width')
  return (
    <Button
      size="icon"
      variant={active ? 'default' : 'ghost'}
      className="h-7 w-7"
      disabled={!display?.site}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={() => void setBrowserPageFitWidth(browserPageId, !active).then(setDisplay)}
    >
      <MoveHorizontal className="size-4" />
    </Button>
  )
}
