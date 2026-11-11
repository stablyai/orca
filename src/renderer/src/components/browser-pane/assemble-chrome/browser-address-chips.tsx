import { FileCode2, Monitor, ZoomIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { browserPageZoomLevelToPercent } from '../../../../../shared/browser-page-zoom'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import { getBrowserViewportPreset } from '../../../../../shared/browser-viewport-presets'
import { publishBrowserPageSiteDisplay } from '../host-guest/browser-page-zoom'
import { applyBrowserViewportPreset } from './browser-viewport-preset-apply'
import { useBrowserPageSiteDisplay } from './use-browser-page-site-display'

function AddressChip({
  label,
  tooltip,
  onClick,
  children
}: {
  label: string
  tooltip: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={`${tooltip} (${label})`}
          onClick={onClick}
        >
          {children}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

/** Zoom and viewport show only when they differ from the default; a click puts them back. */
export function BrowserPageStateChips({
  browserPageId,
  url,
  viewportPresetId,
  isActive
}: {
  browserPageId: string
  url: string
  viewportPresetId: BrowserViewportPresetId | null
  isActive: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const display = useBrowserPageSiteDisplay(browserPageId, url, isActive)
  const preset = getBrowserViewportPreset(viewportPresetId)
  const showZoom = Boolean(display?.site && display.siteHasZoom)
  if (!showZoom && !preset) {
    return null
  }
  return (
    <>
      {showZoom && display ? (
        <AddressChip
          label={`${browserPageZoomLevelToPercent(display.zoomLevel)}%`}
          tooltip={t('browser.toolbar.resetZoom', 'Reset zoom')}
          onClick={() =>
            void window.api.browser
              .zoomPage({ browserPageId, direction: 'reset' })
              .then((next) => publishBrowserPageSiteDisplay({ browserPageId, display: next }))
          }
        >
          <ZoomIn className="size-3.5" />
        </AddressChip>
      ) : null}
      {preset ? (
        <AddressChip
          label={`${preset.width} × ${preset.height}`}
          tooltip={t('browser.toolbar.resetViewport', 'Reset viewport size')}
          onClick={() => applyBrowserViewportPreset(browserPageId, null)}
        >
          <Monitor className="size-3.5" />
        </AddressChip>
      ) : null}
    </>
  )
}

export function BrowserOpenSourceFileButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.editor.HtmlDocPreview.openSourceControl', 'Open source file')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={label} onClick={onOpen}>
          <FileCode2 className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
