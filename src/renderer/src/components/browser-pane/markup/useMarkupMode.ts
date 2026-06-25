import { useCallback, useRef, useState } from 'react'
import { GRAB_BUDGET } from '../../../../../shared/browser-grab-types'
import {
  captureMarkupBaseImage,
  type MarkupBaseImage,
  type MarkupCaptureSource
} from './markup-base-image'
import { composeMarkupDataUrl, type MarkupComposeResult } from './markup-screenshot-compose'
import type { MarkupShape } from './markup-drawing-model'

export type MarkupModeState = 'idle' | 'capturing' | 'drawing' | 'composing' | 'error'

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
  error: string | null
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
  const [error, setError] = useState<string | null>(null)
  const contextRef = useRef<MarkupCaptureContext | null>(null)
  // Why: a token invalidates an in-flight capture if the user cancels before it
  // resolves, so the stale promise can't flip state back to 'drawing'.
  const captureTokenRef = useRef(0)

  const reset = useCallback(() => {
    captureTokenRef.current += 1
    contextRef.current = null
    setBaseImage(null)
    setError(null)
    setState('idle')
  }, [])

  const start = useCallback(async () => {
    const context = getCaptureContext()
    if (!context) {
      setError('Screenshot markup is not available on this page.')
      setState('error')
      return
    }
    const token = (captureTokenRef.current += 1)
    contextRef.current = context
    setError(null)
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
      setError('Could not capture the page to draw on.')
      setState('error')
    }
  }, [getCaptureContext])

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
      setState('composing')
      try {
        const result = composeMarkupDataUrl({
          image: imageElement,
          displayCssWidth: context.cssWidth,
          displayCssHeight: context.cssHeight,
          outputScale: context.outputScale,
          shapes,
          maxBytes: GRAB_BUDGET.screenshotMaxBytes
        })
        await onDeliver(result)
        reset()
      } catch {
        setError('Could not attach the markup screenshot.')
        setState('error')
      }
    },
    [onDeliver, reset]
  )

  return {
    state,
    isActive: state !== 'idle',
    baseImage,
    error,
    start,
    cancel,
    complete
  }
}
