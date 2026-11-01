import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { FRAME_EVENTS } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import {
  PLUGIN_FRAME_IPC_CHANNEL,
  PLUGIN_FRAME_KEY_CHANNEL
} from '../../../../shared/plugins/frames/plugin-frame-guest'
import { pluginEvent } from '../../../../shared/plugins/frames/plugin-protocol'
import {
  createPluginFrameEnvelopeHandler,
  createPluginFrameMessageHandler,
  type PluginFrameEditorChannel
} from './plugin-frame-host'
import {
  pluginFrameWindowOf,
  readPluginGuestMessage,
  type PluginFrameElement
} from './plugin-frame-element'
import { createPanelWatchdog } from './plugin-panel-watchdog'
import { usePluginFrameThemeSync } from './use-plugin-panel-theme-revision'

/** Wires one plugin frame (panel or editor, iframe or guest): message host, watchdog and live theme. */
export function usePluginFrameHost(options: {
  surface: 'panel' | 'editor'
  frameRef: RefObject<PluginFrameElement | null>
  /** Changes whenever a new document mounts; null while none is ready. */
  frameKey: string | null
  sessionToken: string | null
  editor?: PluginFrameEditorChannel
  onUnresponsive: () => void
  /** The guest's WebContents went away under an unchanged document (closed, crashed). */
  onGuestGone?: () => void
}): { onFrameLoad: () => void } {
  const { surface, frameRef, frameKey, sessionToken, editor } = options
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null)
  const onUnresponsiveRef = useRef(options.onUnresponsive)
  const onGuestGoneRef = useRef(options.onGuestGone)
  // Why a ref: main rotates sessions without replacing the document or its in-flight calls.
  const sessionTokenRef = useRef(sessionToken)
  useLayoutEffect(() => {
    onUnresponsiveRef.current = options.onUnresponsive
    onGuestGoneRef.current = options.onGuestGone
    sessionTokenRef.current = sessionToken
  })
  const getFrameWindow = useMemo(() => () => pluginFrameWindowOf(frameRef.current), [frameRef])
  usePluginFrameThemeSync(getFrameWindow)

  const watchdog = useMemo(
    () =>
      createPanelWatchdog({
        sendPing: (pingId) =>
          getFrameWindow()?.postMessage(pluginEvent(FRAME_EVENTS.ping, pingId), '*'),
        onUnresponsive: () => onUnresponsiveRef.current()
      }),
    [getFrameWindow]
  )

  // Why layout: the shell posts `ready` as soon as it parses, so listen before it can.
  useLayoutEffect(() => {
    const element = frameRef.current
    if (!frameKey || !element) {
      return
    }
    let active = true
    const hostOptions = {
      surface,
      getFrameWindow,
      getSessionToken: () => sessionTokenRef.current,
      isActive: () => active,
      onPong: (pingId: number) => watchdog.handlePong(pingId),
      editor
    }
    if (element instanceof HTMLIFrameElement) {
      const handler = createPluginFrameMessageHandler(hostOptions)
      window.addEventListener('message', handler)
      return () => {
        active = false
        window.removeEventListener('message', handler)
      }
    }
    // A guest's `ipc-message` can only come from that guest, so the element is the sender check.
    const handle = createPluginFrameEnvelopeHandler(hostOptions)
    const onMessage = (event: Event): void => {
      const message = readPluginGuestMessage(event, PLUGIN_FRAME_IPC_CHANNEL)
      if (message) {
        handle(message.data, {
          userActivation: message.gesture > 0,
          transport: 'guest',
          gesture: message.gesture
        })
        return
      }
      // Trusted modifier chords: the preload saw these as real key presses in this guest.
      const chord = readPluginGuestMessage(event, PLUGIN_FRAME_KEY_CHANNEL)
      if (chord) {
        handle(pluginEvent(FRAME_EVENTS.editorKeydown, chord.data), {
          userActivation: true,
          transport: 'guest',
          trustedChord: true
        })
      }
    }
    const onReady = (): void => setLoadedFrameKey(frameKey)
    const onGone = (): void => onGuestGoneRef.current?.()
    element.addEventListener('ipc-message', onMessage)
    element.addEventListener('dom-ready', onReady)
    element.addEventListener('destroyed', onGone)
    element.addEventListener('render-process-gone', onGone)
    return () => {
      active = false
      element.removeEventListener('ipc-message', onMessage)
      element.removeEventListener('dom-ready', onReady)
      element.removeEventListener('destroyed', onGone)
      element.removeEventListener('render-process-gone', onGone)
    }
  }, [editor, frameKey, frameRef, getFrameWindow, surface, watchdog])

  useEffect(() => {
    if (!frameKey || loadedFrameKey !== frameKey) {
      return
    }
    // Install the shell's pong listener before pinging or a healthy frame may be suspended.
    watchdog.start()
    return () => watchdog.stop()
  }, [frameKey, loadedFrameKey, watchdog])

  return { onFrameLoad: () => setLoadedFrameKey(frameKey) }
}
