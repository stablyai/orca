import { useEffect, useState, useCallback } from 'react'
import { Button } from '../ui/button'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { applyUIZoom } from '@/lib/ui-zoom'
import { ZOOM_STEP, ZOOM_MIN, ZOOM_MAX, zoomLevelToPercent } from './SettingsConstants'

export function UIZoomControl(): React.JSX.Element {
  const [zoomLevel, setZoomLevel] = useState(() => window.api.ui.getZoomLevel())

  useEffect(() => {
    return window.api.ui.onTerminalZoom(() => {
      setZoomLevel(window.api.ui.getZoomLevel())
    })
  }, [])

  const applyZoom = useCallback((level: number) => {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level))
    applyUIZoom(clamped)
    setZoomLevel(clamped)
    window.api.ui.set({ uiZoomLevel: clamped })
  }, [])

  const percent = zoomLevelToPercent(zoomLevel)

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => applyZoom(zoomLevel - ZOOM_STEP)}
        disabled={zoomLevel <= ZOOM_MIN}
      >
        <Minus className="size-3" />
      </Button>
      <span className="w-14 text-center text-sm tabular-nums text-foreground">{percent}%</span>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => applyZoom(zoomLevel + ZOOM_STEP)}
        disabled={zoomLevel >= ZOOM_MAX}
      >
        <Plus className="size-3" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => applyZoom(0)}
        disabled={zoomLevel === 0}
        className="ml-1 gap-1.5"
      >
        <RotateCcw className="size-3" />
        Reset
      </Button>
    </div>
  )
}
