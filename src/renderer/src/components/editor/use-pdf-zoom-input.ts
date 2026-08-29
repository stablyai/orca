import { useCallback, useEffect, type RefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import {
  addPdfZoomCommandListener,
  isActivePdfZoomTarget,
  type PdfZoomDirection
} from '@/lib/pdf-zoom-command'
import {
  applyPdfWheelScale,
  shouldHandlePdfZoomWheel,
  type PdfScalePreference
} from './pdf-scale-preference'

type PdfWheelZoomViewer = {
  currentScale: number
  updateScale: (options: { scaleFactor: number; origin: [number, number] }) => void
}

export function usePdfZoomInput({
  containerRef,
  filePath,
  keybindings,
  scaleBounds,
  scalePreferenceRef,
  viewerRef,
  zoomIn,
  zoomOut,
  zoomReset
}: {
  containerRef: RefObject<HTMLDivElement | null>
  filePath: string
  keybindings: KeybindingOverrides | undefined
  scaleBounds: { min: number; max: number }
  scalePreferenceRef: RefObject<PdfScalePreference>
  viewerRef: RefObject<PdfWheelZoomViewer | null>
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
}): void {
  const applyZoomCommand = useCallback(
    (direction: PdfZoomDirection): void => {
      if (direction === 'in') {
        zoomIn()
      } else if (direction === 'out') {
        zoomOut()
      } else {
        zoomReset()
      }
    },
    [zoomIn, zoomOut, zoomReset]
  )

  const isActiveZoomTarget = useCallback(
    () => isActivePdfZoomTarget(containerRef.current, filePath, useAppStore.getState()),
    [containerRef, filePath]
  )

  useEffect(
    () =>
      addPdfZoomCommandListener((direction) => {
        if (!isActiveZoomTarget()) {
          return false
        }
        applyZoomCommand(direction)
        return true
      }),
    [applyZoomCommand, isActiveZoomTarget]
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const handleWheel = (event: WheelEvent): void => {
      if (!shouldHandlePdfZoomWheel(event, getShortcutPlatform())) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const viewer = viewerRef.current
      if (viewer) {
        scalePreferenceRef.current = applyPdfWheelScale(viewer, event, scaleBounds)
      }
    }
    // Why: Chromium exposes trackpad pinch as ctrl-wheel and requires a native
    // non-passive listener to keep the gesture out of editor/app zoom.
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [containerRef, scaleBounds, scalePreferenceRef, viewerRef])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const platform = getShortcutPlatform()
      if (!isActiveZoomTarget()) {
        return
      }
      if (keybindingMatchesAction('zoom.in', event, platform, keybindings)) {
        event.preventDefault()
        applyZoomCommand('in')
      } else if (keybindingMatchesAction('zoom.out', event, platform, keybindings)) {
        event.preventDefault()
        applyZoomCommand('out')
      } else if (keybindingMatchesAction('zoom.reset', event, platform, keybindings)) {
        event.preventDefault()
        applyZoomCommand('reset')
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [applyZoomCommand, isActiveZoomTarget, keybindings])
}
