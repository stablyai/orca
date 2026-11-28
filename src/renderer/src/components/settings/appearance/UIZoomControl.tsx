import { Minus, Plus, RotateCcw } from 'lucide-react'
import { changeRegionZoom } from '@/app-shell/chrome/region-zoom'
import { useTranslate } from '@/i18n/use-translate'
import { useShortcutKeyComboDetails } from '@/lib/keyboard/useShortcutLabel'
import { useAppStore } from '@/store/index'
import {
  UI_ZOOM_MIN,
  UI_ZOOM_MAX,
  zoomLevelToPercent,
  type UIZoomRegion
} from '../../../../../shared/app-lifecycle/windows/ui-zoom-level'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { ShortcutHintList } from './AppearanceShortcutHintList'

export function UIZoomControl({
  region,
  label
}: {
  region: UIZoomRegion
  label: string
}): React.JSX.Element {
  const t = useTranslate()
  const level = useAppStore((state) =>
    region === 'sidebar' ? state.sidebarZoomLevel : state.uiZoomLevel
  )
  const zoomOut = t('settings.appearance.uiZoom.zoomOut', 'Zoom out')
  const zoomIn = t('settings.appearance.uiZoom.zoomIn', 'Zoom in')
  const outShortcut = useShortcutKeyComboDetails(`zoom.${region}.out`)
  const inShortcut = useShortcutKeyComboDetails(`zoom.${region}.in`)

  return (
    <div role="group" aria-label={label} className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => changeRegionZoom(region, 'out')}
            disabled={level <= UI_ZOOM_MIN}
            aria-label={zoomOut}
          >
            <Minus className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {zoomOut} <ShortcutHintList combos={outShortcut} />
        </TooltipContent>
      </Tooltip>
      <span className="w-14 text-center text-sm tabular-nums text-foreground">
        {zoomLevelToPercent(level)}%
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => changeRegionZoom(region, 'in')}
            disabled={level >= UI_ZOOM_MAX}
            aria-label={zoomIn}
          >
            <Plus className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {zoomIn} <ShortcutHintList combos={inShortcut} />
        </TooltipContent>
      </Tooltip>
      <Button
        variant="outline"
        size="sm"
        onClick={() => changeRegionZoom(region, 'reset')}
        disabled={level === 0}
        className="ml-1 gap-1.5"
      >
        <RotateCcw className="size-3" />
        {t('auto.components.settings.UIZoomControl.c2c64b24d0', 'Reset')}
      </Button>
    </div>
  )
}
