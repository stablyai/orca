import { useEffect, useState, useCallback } from 'react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { applyUIZoom } from '@/app-shell/chrome/ui-zoom'
import {
  UI_ZOOM_MIN as ZOOM_MIN,
  UI_ZOOM_MAX as ZOOM_MAX,
  percentTextToZoomLevel,
  stepUIZoomLevel,
  zoomLevelToPercent
} from '../../../../../shared/app-lifecycle/windows/ui-zoom-level'
import { useTranslate } from '@/i18n/use-translate'

export function UIZoomControl(): React.JSX.Element {
  const t = useTranslate()
  const [zoomLevel, setZoomLevel] = useState(() => window.api.ui.getZoomLevel())
  // The typed text while the field is being edited; null shows the current percentage.
  const [draft, setDraft] = useState<string | null>(null)

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

  const commitDraft = (): void => {
    if (draft === null) {
      return
    }
    const level = percentTextToZoomLevel(draft)
    setDraft(null)
    if (level !== null) {
      applyZoom(level)
    }
  }

  const percent = zoomLevelToPercent(zoomLevel)

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => applyZoom(stepUIZoomLevel(zoomLevel, 'out'))}
        disabled={zoomLevel <= ZOOM_MIN}
        aria-label={t('settings.appearance.uiZoom.zoomOut', 'Zoom out')}
      >
        <Minus className="size-3" />
      </Button>
      <div className="flex items-center gap-0.5 tabular-nums">
        {/* Text with a numeric keypad, not type="number": its spinners would duplicate the − and + buttons. */}
        <Input
          type="text"
          inputMode="decimal"
          aria-label={t('auto.components.settings.AppearancePane.173edfb768', 'UI zoom')}
          value={draft ?? String(percent)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitDraft()
            } else if (event.key === 'Escape' && draft !== null) {
              // Escape while editing only undoes the edit; with nothing typed it passes through.
              event.stopPropagation()
              setDraft(null)
            }
          }}
          className="w-14 text-center"
        />
        <span className="text-sm text-muted-foreground">%</span>
      </div>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => applyZoom(stepUIZoomLevel(zoomLevel, 'in'))}
        disabled={zoomLevel >= ZOOM_MAX}
        aria-label={t('settings.appearance.uiZoom.zoomIn', 'Zoom in')}
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
        {t('auto.components.settings.UIZoomControl.c2c64b24d0', 'Reset')}
      </Button>
    </div>
  )
}
