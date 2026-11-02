import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { openHttpLink } from '@/lib/http-link-routing'
import {
  NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX,
  NATIVE_CHAT_VISUAL_PONG_TIMEOUT_MS,
  buildNativeChatVisualDocument,
  nativeChatVisualPingMessage,
  nativeChatVisualThemeMessage,
  readNativeChatVisualFrameMessage,
  readNativeChatVisualPong
} from '../../../../shared/native-chat/native-chat-visual-shell'
import type { NativeChatVisualDocument } from './native-chat-visual-read-client'
import { createNativeChatVisualHeightGovernor } from '../../../../shared/native-chat/native-chat-visual-height-governor'
import type { ReaderGesture } from './native-chat-autoscroll'
import { useNativeChatVisualTheme } from './use-native-chat-visual-theme'
import { useWebviewDragPassthroughActive } from '../browser-pane/host-guest/use-webview-drag-passthrough-active'

/** Height reserved before a visual reports its own, so the reply below does not jump far. */
export const NATIVE_CHAT_VISUAL_RESERVED_HEIGHT = 160
// Allow one link per Chromium activation window so one click cannot open multiple pages.
const LINK_COOLDOWN_MS = 5_000

function newChannel(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Use an opaque script-only frame and restyle in place; unanswered later loads retire it as a tripwire, not a security boundary. */
export function NativeChatVisualFrame({
  document: visual,
  title,
  themeScope,
  onRetired,
  onReaderGesture
}: {
  document: NativeChatVisualDocument
  title: string
  /** An element already mounted where the frame sits, so the first paint wears that scope's theme. */
  themeScope: RefObject<Element | null>
  onRetired: () => void
  /** Uncancelled input; the transcript owner checks whether the conversation moved. */
  onReaderGesture?: (gesture: ReaderGesture) => void
}): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const theme = useNativeChatVisualTheme(themeScope)
  // Why: a frame takes the pointer stream from Orca's document, so a tab dragged over it could not drop here.
  const dragPassthrough = useWebviewDragPassthroughActive()
  // The latest theme for the next document build and the load-time post, without rebuilding on it.
  const themeRef = useRef(theme)
  const onReaderGestureRef = useRef(onReaderGesture)
  useLayoutEffect(() => {
    themeRef.current = theme
    onReaderGestureRef.current = onReaderGesture
  }, [onReaderGesture, theme])
  const [height, setHeight] = useState(NATIVE_CHAT_VISUAL_RESERVED_HEIGHT)
  const loadsRef = useRef(0)
  // The latest later load still awaiting an answer, and the timer that retires the frame.
  const unansweredRef = useRef<{ id: number; timer: ReturnType<typeof setTimeout> } | null>(null)

  // Built once per revision: the theme at build time paints first, later themes arrive by message.
  const built = useMemo(() => {
    const channel = newChannel()
    return {
      channel,
      srcDoc: buildNativeChatVisualDocument({
        html: visual.html,
        channel,
        theme: themeRef.current
      })
    }
  }, [visual.html])

  useEffect(() => {
    loadsRef.current = 0
    const governor = createNativeChatVisualHeightGovernor()
    let deferred: ReturnType<typeof setTimeout> | null = null
    let latestReported: number | null = null
    let lastLinkAt = -Infinity
    const applyHeight = (): void => {
      deferred = null
      if (latestReported === null) {
        return
      }
      const decision = governor.decide(latestReported, performance.now())
      if (decision.kind === 'apply') {
        setHeight(decision.height)
      } else if (decision.kind === 'defer') {
        deferred = setTimeout(applyHeight, decision.retryInMs)
      }
    }
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) {
        return
      }
      const pong = readNativeChatVisualPong(event.data, built.channel)
      if (pong !== null) {
        if (pong === unansweredRef.current?.id) {
          clearTimeout(unansweredRef.current.timer)
          unansweredRef.current = null
        }
        return
      }
      const message = readNativeChatVisualFrameMessage(event.data, built.channel)
      if (!message) {
        return
      }
      if (message.kind === 'size') {
        latestReported = message.height
        if (!deferred) {
          applyHeight()
        }
        return
      }
      if (message.kind === 'reader-scroll') {
        onReaderGestureRef.current?.(
          message.input === 'wheel'
            ? { kind: 'wheel', deltaY: message.deltaY, zoom: false }
            : { kind: 'touch-drag' }
        )
        return
      }
      // Require recent input in this focused frame; this blocks load-time opens but cannot prove the gesture named this link.
      const now = performance.now()
      if (
        window.document.activeElement !== frame ||
        navigator.userActivation?.isActive !== true ||
        now - lastLinkAt < LINK_COOLDOWN_MS
      ) {
        return
      }
      lastLinkAt = now
      openHttpLink(message.url, { forceSystemBrowser: true })
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (deferred) {
        clearTimeout(deferred)
      }
    }
  }, [built.channel])

  // A frame rebuilt for a new revision, or unmounted, owes no answer.
  useEffect(
    () => () => {
      if (unansweredRef.current) {
        clearTimeout(unansweredRef.current.timer)
        unansweredRef.current = null
      }
    },
    [built.channel]
  )

  useEffect(() => {
    if (loadsRef.current > 0) {
      frameRef.current?.contentWindow?.postMessage(
        nativeChatVisualThemeMessage(theme, built.channel),
        '*'
      )
    }
  }, [built.channel, theme])

  return (
    <div className="w-full" style={{ height }}>
      <iframe
        key={built.channel}
        ref={frameRef}
        name={`${NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX}${built.channel}`}
        title={title}
        srcDoc={built.srcDoc}
        // Never allow-same-origin: the opaque origin keeps the page away from Orca's own.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="block size-full border-0 bg-transparent"
        style={{
          colorScheme: theme.colorScheme,
          pointerEvents: dragPassthrough ? 'none' : undefined
        }}
        onLoad={() => {
          loadsRef.current += 1
          const frameWindow = frameRef.current?.contentWindow
          if (loadsRef.current > 1) {
            // A tripwire for a frame gone blank or to another page (WebKit also loads on `#x`).
            if (unansweredRef.current) {
              clearTimeout(unansweredRef.current.timer)
            }
            unansweredRef.current = {
              id: loadsRef.current,
              timer: setTimeout(onRetired, NATIVE_CHAT_VISUAL_PONG_TIMEOUT_MS)
            }
            frameWindow?.postMessage(
              nativeChatVisualPingMessage(loadsRef.current, built.channel),
              '*'
            )
          }
          // Covers a theme change that landed while the page loaded.
          frameWindow?.postMessage(
            nativeChatVisualThemeMessage(themeRef.current, built.channel),
            '*'
          )
        }}
      />
    </div>
  )
}
