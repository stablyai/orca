import { Minus, Plus, RotateCcw, SunMoon, ZoomIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  browserPageZoomLevelToPercent,
  nextBrowserPageZoomLevel,
  type BrowserPageZoomDirection
} from '../../../../../shared/browser-page-zoom'
import {
  isBrowserSiteColorScheme,
  type BrowserPageSiteDisplay,
  type BrowserSiteColorScheme
} from '../../../../../shared/browser-site-display'

const ZOOM_KEY_DIRECTIONS: Record<string, BrowserPageZoomDirection> = {
  '-': 'out',
  '=': 'in',
  '+': 'in',
  '0': 'reset'
}

export function BrowserToolbarZoomRow({
  display,
  onZoom
}: {
  display: BrowserPageSiteDisplay | null
  onZoom: (direction: BrowserPageZoomDirection) => void
}): React.JSX.Element {
  const zoomLevel = display?.zoomLevel ?? 0
  const percent = browserPageZoomLevelToPercent(zoomLevel)
  return (
    <DropdownMenuItem
      disabled={!display?.site}
      aria-label={translate(
        'auto.components.browser.pane.BrowserToolbarMenu.zoomPercent',
        'Zoom {{value0}}%',
        { value0: percent }
      )}
      // Why: keep the menu open so zoom can be stepped more than once.
      onSelect={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const direction = ZOOM_KEY_DIRECTIONS[event.key]
        if (direction) {
          event.preventDefault()
          onZoom(direction)
        }
      }}
    >
      <ZoomIn className="mr-2 size-3.5" />
      {translate('auto.components.browser.pane.BrowserToolbarMenu.zoom', 'Zoom')}
      <span className="ml-auto flex items-center">
        <Button
          variant="ghost"
          size="icon-xs"
          tabIndex={-1}
          disabled={nextBrowserPageZoomLevel(zoomLevel, 'out') === zoomLevel}
          aria-label={translate(
            'auto.components.browser.pane.BrowserToolbarMenu.zoomOut',
            'Zoom out'
          )}
          onClick={() => onZoom('out')}
        >
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          tabIndex={-1}
          aria-label={translate(
            'auto.components.browser.pane.BrowserToolbarMenu.resetZoom',
            'Reset zoom'
          )}
          onClick={() => onZoom('reset')}
        >
          <span className="min-w-8 tabular-nums">{percent}%</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          tabIndex={-1}
          disabled={nextBrowserPageZoomLevel(zoomLevel, 'in') === zoomLevel}
          aria-label={translate(
            'auto.components.browser.pane.BrowserToolbarMenu.zoomIn',
            'Zoom in'
          )}
          onClick={() => onZoom('in')}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          tabIndex={-1}
          disabled={!display?.siteHasZoom}
          aria-label={translate(
            'auto.components.browser.pane.BrowserToolbarMenu.resetZoom',
            'Reset zoom'
          )}
          onClick={() => onZoom('reset')}
        >
          <RotateCcw />
        </Button>
      </span>
    </DropdownMenuItem>
  )
}

const MATCH_ORCA_VALUE = 'orca'

export function BrowserToolbarAppearanceSub({
  browserPageId,
  display,
  onSetColorScheme
}: {
  browserPageId: string
  display: BrowserPageSiteDisplay | null
  onSetColorScheme: (colorScheme: BrowserSiteColorScheme | null) => void
}): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!display?.site}>
        <SunMoon className="mr-2 size-3.5" />
        {translate('auto.components.browser.pane.BrowserToolbarMenu.appearance', 'Appearance')}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent data-browser-page-menu-id={browserPageId}>
          <DropdownMenuRadioGroup
            value={display?.colorScheme ?? MATCH_ORCA_VALUE}
            onValueChange={(value) =>
              onSetColorScheme(isBrowserSiteColorScheme(value) ? value : null)
            }
          >
            <DropdownMenuRadioItem value={MATCH_ORCA_VALUE}>
              {translate(
                'auto.components.browser.pane.BrowserToolbarMenu.appearanceMatchOrca',
                'Match Orca'
              )}
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioItem value="light">
              {translate(
                'auto.components.browser.pane.BrowserToolbarMenu.appearanceLight',
                'Light'
              )}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              {translate('auto.components.browser.pane.BrowserToolbarMenu.appearanceDark', 'Dark')}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}
