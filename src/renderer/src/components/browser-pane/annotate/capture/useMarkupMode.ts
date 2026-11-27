import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
} from '../../../../../../shared/clipboard/clipboard-image'
import {
  captureMarkupBaseImage,
  type MarkupBaseImage,
  type MarkupCaptureSource
} from './markup-base-image'
import { composeMarkupDataUrl, type MarkupComposeResult } from './markup-screenshot-compose'
import type { MarkupShape } from '../drawing/markup-drawing-model'

export type MarkupModeState = 'idle' | 'capturing' | 'drawing' | 'composing'

// Resolve the environment-specific capture source and display geometry lazily when starting.
export type MarkupCaptureContext = {
  source: MarkupCaptureSource
  cssWidth: number
  cssHeight: number
  outputScale: number
  /** False once the page this capture began on is gone, so its result or error is dropped silently. */
  isCurrent?: () => boolean
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
  /** `onContextReady` runs only once the page can be captured, so callers never act on a Draw that can't start. */
  start: (onContextReady?: () => void) => Promise<void>
  cancel: () => void
  /** Drops a capture still in flight (its document or viewer is gone) without an error; a drawing stays open. */
  abandonCapture: () => void
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

  // Aborting retires the capture in flight, including its attempt in main.
  const captureAbortRef = useRef<AbortController | null>(null)

  // Unmount retires any capture in flight at commit, before passive cleanup or any held reply can run, so a closed
  // owner never captures, updates state, or shows an error toast, even while its guest stays connected elsewhere.
  useLayoutEffect(
    () => () => {
      captureTokenRef.current += 1
      captureAbortRef.current?.abort()
    },
    []
  )

  const reset = useCallback(() => {
    captureAbortRef.current?.abort()
    captureAbortRef.current = null
    captureTokenRef.current += 1
    contextRef.current = null
    setBaseImage(null)
    setState('idle')
  }, [])

  const reportError = useCallback((key: string, fallback: string) => {
    toast.error(translate(key, fallback))
  }, [])

  const start = useCallback(
    async (onContextReady?: () => void) => {
      const context = getCaptureContext()
      if (!context) {
        reportError(
          'auto.components.browser-pane.markup.errorUnavailable',
          'Screenshot markup is not available on this page.'
        )
        return
      }
      onContextReady?.()
      captureAbortRef.current?.abort()
      const abort = new AbortController()
      captureAbortRef.current = abort
      const token = (captureTokenRef.current += 1)
      contextRef.current = context
      setState('capturing')
      const isStale = (): boolean => {
        if (captureTokenRef.current !== token) {
          return true
        }
        if (context.isCurrent?.() === false) {
          reset()
          return true
        }
        return false
      }
      try {
        const image = await captureMarkupBaseImage(context.source, abort.signal)
        if (isStale()) {
          return
        }
        if (context.source.kind === 'clean-page' && Date.now() >= context.source.deadlineMs) {
          throw new Error('markup: the capture finished after its deadline')
        }
        captureAbortRef.current = null
        setBaseImage(image)
        setState('drawing')
      } catch {
        if (isStale()) {
          return
        }
        // Return to idle on capture failure; no overlay exists to offer recovery.
        reportError(
          'auto.components.browser-pane.markup.errorCapture',
          'Could not capture the page to draw on.'
        )
        reset()
      }
    },
    [getCaptureContext, reportError, reset]
  )

  const cancel = useCallback(() => {
    reset()
  }, [reset])

  const abandonCapture = useCallback(() => {
    if (captureAbortRef.current) {
      reset()
    }
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
    abandonCapture,
    complete
  }
}
