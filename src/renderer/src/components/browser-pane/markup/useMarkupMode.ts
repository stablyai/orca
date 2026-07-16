import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
} from '../../../../../shared/clipboard-image'
import {
  captureMarkupBaseImage,
  type MarkupBaseImage,
  type MarkupCaptureSource
} from './markup-base-image'
import { composeMarkupDataUrl, type MarkupComposeResult } from './markup-screenshot-compose'
import type { MarkupShape } from './markup-drawing-model'

export type MarkupModeState = 'idle' | 'capturing' | 'drawing' | 'composing'

// Where to capture the base image from, plus the on-screen geometry used to
// size and scale the composite. Resolved lazily at start() time by the owner
// (BrowserPane) since it depends on which environment the pane is showing.
export type MarkupCaptureContext = {
  source: MarkupCaptureSource
  cssWidth: number
  cssHeight: number
  outputScale: number
}

export type MarkupCompleteInput = {
  imageElement: CanvasImageSource
  shapes: readonly MarkupShape[]
}

type UseMarkupModeParams = {
  getCaptureContext: () => MarkupCaptureContext | null
  onDeliver: (result: MarkupComposeResult) => Promise<void> | void
}

export type MarkupModeController = {
  state: MarkupModeState
  isActive: boolean
  baseImage: MarkupBaseImage | null
  start: () => Promise<void>
  cancel: () => void
  complete: (input: MarkupCompleteInput) => Promise<void>
}

export function useMarkupMode({
  getCaptureContext,
  onDeliver
}: UseMarkupModeParams): MarkupModeController {
  const [state, setState] = useState<MarkupModeState>('idle')
  const [baseImage, setBaseImage] = useState<MarkupBaseImage | null>(null)
  const contextRef = useRef<MarkupCaptureContext | null>(null)
  // Why: a token invalidates an in-flight capture if the user cancels before it
  // resolves, so the stale promise can't flip state back to 'drawing'.
  const captureTokenRef = useRef(0)

  const reset = useCallback(() => {
    captureTokenRef.current += 1
    contextRef.current = null
    setBaseImage(null)
    setState('idle')
  }, [])

  const reportError = useCallback((key: string, fallback: string) => {
    toast.error(translate(key, fallback))
  }, [])

  const start = useCallback(async () => {
    const context = getCaptureContext()
    if (!context) {
      reportError(
        'auto.components.browser-pane.markup.errorUnavailable',
        'Screenshot markup is not available on this page.'
      )
      return
    }
    const token = (captureTokenRef.current += 1)
    contextRef.current = context
    setState('capturing')
    try {
      const image = await captureMarkupBaseImage(context.source)
      if (captureTokenRef.current !== token) {
        return
      }
      setBaseImage(image)
      setState('drawing')
    } catch {
      if (captureTokenRef.current !== token) {
        return
      }
      // Why: a capture failure has no overlay to fall back to, so return to idle
      // (not a stuck 'active' state with no surface and an inert Escape).
      reportError(
        'auto.components.browser-pane.markup.errorCapture',
        'Could not capture the page to draw on.'
      )
      reset()
    }
  }, [getCaptureContext, reportError, reset])

  const cancel = useCallback(() => {
    reset()
  }, [reset])

  const complete = useCallback(
    async ({ imageElement, shapes }: MarkupCompleteInput) => {
      const context = contextRef.current
      if (!context) {
        reset()
        return
      }
      // Why: invalidate this completion if the user cancels or restarts while
      // onDeliver is pending, so a stale callback can't reset/error the new session.
      const token = captureTokenRef.current
      setState('composing')
      // Why: yield a frame so the busy 'composing' UI (disabled buttons, progress
      // cursor) paints before the synchronous composite raster runs — otherwise
      // Copy freezes with no visible feedback. Skip the work if cancelled meanwhile.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (captureTokenRef.current !== token) {
        return
      }
      try {
        const result = await composeMarkupDataUrl({
          image: imageElement,
          displayCssWidth: context.cssWidth,
          displayCssHeight: context.cssHeight,
          outputScale: context.outputScale,
          shapes,
          // Why: target the clipboard handler's own ceilings — the byte limit
          // (≈18 MB, well above a normal viewport PNG) and the pixel limit, which
          // the handler otherwise enforces by silently dropping oversize images.
          maxBytes: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
          maxPixels: CLIPBOARD_IMAGE_MAX_PIXELS
        })
        // Why: re-check before delivering — the async compose is a wide window in
        // which the user can Escape/cancel, and onDeliver writes the clipboard
        // irreversibly. Without this, a cancelled session still overwrites it.
        if (captureTokenRef.current !== token) {
          return
        }
        await onDeliver(result)
        if (captureTokenRef.current !== token) {
          return
        }
        reset()
      } catch {
        if (captureTokenRef.current !== token) {
          return
        }
        // Why: the frozen backdrop is still valid, so return to drawing (not a
        // dead-end error state) — the user can retry Copy or Cancel out.
        reportError(
          'auto.components.browser-pane.markup.errorAttach',
          'Could not attach the markup screenshot.'
        )
        setState('drawing')
      }
    },
    [onDeliver, reset, reportError]
  )

  return {
    state,
    isActive: state !== 'idle',
    baseImage,
    start,
    cancel,
    complete
  }
}
