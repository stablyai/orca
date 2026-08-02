import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'

const FIRST_FRAME_TIMEOUT_MS = 6_000

type EmulatorFrameStreamState = {
  error: string | null
  frameUrl: string | null
  streamIdentity: string | null
}

function createFrameUrl(bytes: ArrayBuffer): string {
  return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
}

function getFrameStreamIdentity(
  streamUrl: string | undefined,
  streamKey: string | undefined,
  enabled: boolean
): string | null {
  return enabled && streamUrl ? `${streamUrl}::${streamKey ?? ''}` : null
}

export function useEmulatorFrameStream(
  streamUrl: string | undefined,
  streamKey: string | undefined,
  enabled: boolean
): Omit<EmulatorFrameStreamState, 'streamIdentity'> {
  const streamIdentity = getFrameStreamIdentity(streamUrl, streamKey, enabled)
  const [state, setState] = useState<EmulatorFrameStreamState>({
    error: null,
    frameUrl: null,
    streamIdentity: null
  })
  const currentFrameUrlRef = useRef<string | null>(null)

  useEffect(() => {
    const emulatorApi = window.api?.emulator
    if (!enabled || !streamUrl || !emulatorApi?.startFrameStream) {
      setState({ error: null, frameUrl: null, streamIdentity: null })
      return
    }

    let disposed = false
    let activeStreamId: string | null = null
    let firstFrameTimer: number | null = window.setTimeout(() => {
      setState((current) =>
        current.streamIdentity !== streamIdentity || current.frameUrl
          ? current
          : {
              ...current,
              error: translate(
                'auto.components.emulator.pane.use.emulator.frame.stream.f1c0179002',
                'Stream is not producing frames.'
              )
            }
      )
    }, FIRST_FRAME_TIMEOUT_MS)

    const clearFirstFrameTimer = (): void => {
      if (firstFrameTimer !== null) {
        window.clearTimeout(firstFrameTimer)
        firstFrameTimer = null
      }
    }

    const revokeCurrentFrameUrl = (): void => {
      if (currentFrameUrlRef.current) {
        URL.revokeObjectURL(currentFrameUrlRef.current)
        currentFrameUrlRef.current = null
      }
    }

    const unsubscribeFrame = emulatorApi.onFrameStreamFrame?.(({ streamId, bytes }) => {
      if (disposed || streamId !== activeStreamId) {
        return
      }
      clearFirstFrameTimer()
      const nextFrameUrl = createFrameUrl(bytes)
      const previousFrameUrl = currentFrameUrlRef.current
      currentFrameUrlRef.current = nextFrameUrl
      setState({ error: null, frameUrl: nextFrameUrl, streamIdentity })
      if (previousFrameUrl) {
        URL.revokeObjectURL(previousFrameUrl)
      }
    })

    const unsubscribeError = emulatorApi.onFrameStreamError?.(({ streamId, message }) => {
      if (!disposed && streamId === activeStreamId) {
        setState((current) =>
          current.streamIdentity === streamIdentity
            ? { ...current, error: message || 'Stream disconnected' }
            : current
        )
      }
    })

    // Why: a device switch gets a fresh stream identity, so stale frames from
    // the previous device are hidden while the new MJPEG stream starts.
    setState({ error: null, frameUrl: null, streamIdentity })
    void emulatorApi
      .startFrameStream({ streamUrl, streamKey })
      .then(({ streamId }) => {
        if (disposed) {
          void emulatorApi.stopFrameStream?.({ streamId })
          return
        }
        activeStreamId = streamId
      })
      .catch((error) => {
        if (disposed) {
          return
        }
        clearFirstFrameTimer()
        setState({
          error: error instanceof Error ? error.message : 'Stream disconnected',
          frameUrl: null,
          streamIdentity
        })
      })

    return () => {
      disposed = true
      clearFirstFrameTimer()
      unsubscribeFrame?.()
      unsubscribeError?.()
      if (activeStreamId) {
        void emulatorApi.stopFrameStream?.({ streamId: activeStreamId })
      }
      revokeCurrentFrameUrl()
    }
  }, [enabled, streamIdentity, streamKey, streamUrl])

  if (state.streamIdentity !== streamIdentity) {
    return { error: null, frameUrl: null }
  }
  return { error: state.error, frameUrl: state.frameUrl }
}
