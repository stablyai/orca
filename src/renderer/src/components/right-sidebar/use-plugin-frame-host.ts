import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { FRAME_EVENTS } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { pluginEvent } from '../../../../shared/plugins/frames/plugin-protocol'
import { createPluginFrameMessageHandler, type PluginFrameEditorChannel } from './plugin-frame-host'
import { createPanelWatchdog } from './plugin-panel-watchdog'
import { usePluginFrameThemeSync } from './use-plugin-panel-theme-revision'

/** Wires one plugin frame (panel or editor): message host, watchdog and live theme. */
export function usePluginFrameHost(options: {
  surface: 'panel' | 'editor'
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** Changes whenever a new document mounts; null while none is ready. */
  frameKey: string | null
  sessionToken: string | null
  editor?: PluginFrameEditorChannel
  onUnresponsive: () => void
}): { onFrameLoad: () => void } {
  const { surface, iframeRef, frameKey, sessionToken, editor } = options
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null)
  const onUnresponsiveRef = useRef(options.onUnresponsive)
  // Why a ref: main rotates sessions without replacing the document or its in-flight calls.
  const sessionTokenRef = useRef(sessionToken)
  useLayoutEffect(() => {
    onUnresponsiveRef.current = options.onUnresponsive
    sessionTokenRef.current = sessionToken
  })
  usePluginFrameThemeSync(iframeRef)

  const watchdog = useMemo(
    () =>
      createPanelWatchdog({
        sendPing: (pingId) =>
          iframeRef.current?.contentWindow?.postMessage(
            pluginEvent(FRAME_EVENTS.ping, pingId),
            '*'
          ),
        onUnresponsive: () => onUnresponsiveRef.current()
      }),
    [iframeRef]
  )

  // Why layout: the shell posts `ready` as soon as srcdoc parses, so listen before it can.
  useLayoutEffect(() => {
    if (!frameKey) {
      return
    }
    let active = true
    const handler = createPluginFrameMessageHandler({
      surface,
      getFrameWindow: () => iframeRef.current?.contentWindow ?? null,
      getSessionToken: () => sessionTokenRef.current,
      isActive: () => active,
      onPong: (pingId) => watchdog.handlePong(pingId),
      editor
    })
    window.addEventListener('message', handler)
    return () => {
      active = false
      window.removeEventListener('message', handler)
    }
  }, [editor, frameKey, iframeRef, surface, watchdog])

  useEffect(() => {
    if (!frameKey || loadedFrameKey !== frameKey) {
      return
    }
    // Install the srcdoc pong listener before pinging or a healthy frame may be suspended.
    watchdog.start()
    return () => watchdog.stop()
  }, [frameKey, loadedFrameKey, watchdog])

  return { onFrameLoad: () => setLoadedFrameKey(frameKey) }
}
