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

// Resolve the environment-specific capture source and display geometry lazily when starting.
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
  // Cancellation invalidates pending captures so stale completions cannot reopen drawing.
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
      // Return to idle on capture failure; no overlay exists to offer recovery.
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
      // Fence delivery completions so a cancelled/restarted session cannot be reset by stale callbacks.
      const token = captureTokenRef.current
      setState('composing')
      // Yield a frame for busy feedback before raster work, then recheck cancellation.
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
          // Match the clipboard handler’s byte/pixel ceilings; oversize dimensions are silently rejected.
          maxBytes: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
          maxPixels: CLIPBOARD_IMAGE_MAX_PIXELS
        })
        // Recheck after async composition before the clipboard write; cancellation must preserve the user’s clipboard.
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
        // Keep the valid frozen backdrop so delivery failure can retry Copy or Cancel.
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
