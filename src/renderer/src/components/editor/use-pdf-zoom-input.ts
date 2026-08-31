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

export function replacePdfZoomWheelTarget(
  current: HTMLDivElement | null,
  next: HTMLDivElement | null,
  handleWheel: (event: WheelEvent) => void
): HTMLDivElement | null {
  current?.removeEventListener('wheel', handleWheel)
  next?.addEventListener('wheel', handleWheel, { passive: false })
  return next
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
}): (container: HTMLDivElement | null) => void {
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

  const handleWheel = useCallback(
    (event: WheelEvent): void => {
      // Why: direct wheel input is pointer-owned like ImageViewer; active ownership applies to global commands.
      if (!shouldHandlePdfZoomWheel(event, getShortcutPlatform())) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const viewer = viewerRef.current
      if (viewer) {
        scalePreferenceRef.current = applyPdfWheelScale(viewer, event, scaleBounds)
      }
    },
    [scaleBounds, scalePreferenceRef, viewerRef]
  )

  const setContainerRef = useCallback(
    (container: HTMLDivElement | null): void => {
      // Why: callback refs detach and reattach native listeners when error/recovery replaces the DOM node.
      containerRef.current = replacePdfZoomWheelTarget(containerRef.current, container, handleWheel)
    },
    [containerRef, handleWheel]
  )

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

  return setContainerRef
}
