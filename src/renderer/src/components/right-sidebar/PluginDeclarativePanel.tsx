import React, { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { PLUGIN_DECLARATIVE_MESSAGES } from '../../../../shared/plugins/declarative/plugin-declarative-message-names'
import type { PluginFrameGuest } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { pluginEvent } from '../../../../shared/plugins/frames/plugin-protocol'
import { PLUGIN_FRAME_USER_METHODS } from '../../../../shared/plugins/workers/plugin-host-api'
import { PluginDeclarativeView } from '@/components/plugins/declarative/PluginDeclarativeView'
import type { PluginDeclarativeEmit } from '@/components/plugins/declarative/PluginDeclarativeControls'
import { callPanelActionViaPreload } from './plugin-frame-host'
import {
  PluginFrameView,
  pluginFrameWindowOf,
  type PluginFrameElement
} from './plugin-frame-element'
import { usePluginFrameHost } from './use-plugin-frame-host'
import { usePluginDeclarativeTree } from './use-plugin-declarative-tree'
import { usePluginDeclarativeState } from './use-plugin-declarative-state'
import { useReportDeclarativePanelDraw } from './use-plugin-panel-draw-report'
import { usePluginDeclarativeImages } from './use-plugin-declarative-images'
import { usePluginPanelActDriver } from './plugin-panel-act-driver'
import { useAppStore } from '@/store'
import {
  PluginDeclarativeIssueNotice,
  PluginDeclarativeReloadedNotice
} from './PluginDeclarativePanelNotices'

type PluginDeclarativePanelProps = {
  tabKey: string
  panelId: string
  title: string
  guest: PluginFrameGuest
  frameKey: string
  sessionToken: string | null
  onUnresponsive: () => void
  /** Dev folder: saves swap the guest under this panel, keeping its last tree and memory atoms. */
  hotReload?: boolean
}

function subscribeDocumentVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

/**
 * A components panel: a hidden guest runs the plugin's module, Orca draws the tree it sends.
 * The guest lives while this panel is the open right-sidebar tab (also while the sidebar is
 * collapsed or Orca's window is hidden, which `visible` reports); switching tabs or closing it
 * ends the guest, and only persisted atoms carry over.
 */
export function PluginDeclarativePanel({
  tabKey,
  panelId,
  title,
  guest,
  frameKey,
  sessionToken,
  onUnresponsive,
  hotReload = false
}: PluginDeclarativePanelProps): React.JSX.Element {
  const frameRef = useRef<PluginFrameElement | null>(null)
  const sendToGuest = useCallback((event: string, payload: unknown) => {
    pluginFrameWindowOf(frameRef.current)?.postMessage(pluginEvent(event, payload), '*')
  }, [])
  const sidebarOpen = useAppStore((store) => store.rightSidebarOpen)
  const windowVisible = useSyncExternalStore(
    subscribeDocumentVisibility,
    () => document.visibilityState !== 'hidden'
  )
  const state = usePluginDeclarativeState({
    panelId,
    sessionToken,
    visible: sidebarOpen && windowVisible,
    sendToGuest,
    hotReload
  })
  const {
    rendered,
    issue,
    reloads,
    dismissIssue,
    channel,
    gestures,
    admitPress,
    consumePress,
    isGestureSettled,
    resetDocument
  } = usePluginDeclarativeTree(sendToGuest, {
    onGuestEvent: (event, payload) => state.onGuestEvent(event, payload)
  })
  // A reload, navigation or (dev save) new guest brings a fresh runtime counting revisions from 1.
  useLayoutEffect(() => {
    resetDocument()
    const frame = frameRef.current
    frame?.addEventListener('did-start-loading', resetDocument)
    return () => frame?.removeEventListener('did-start-loading', resetDocument)
  }, [frameKey, resetDocument])
  const loadImage = usePluginDeclarativeImages(sessionToken)
  const sessionTokenRef = useRef(sessionToken)
  useLayoutEffect(() => {
    sessionTokenRef.current = sessionToken
  })

  useReportDeclarativePanelDraw(tabKey, guest.url, rendered?.document ?? null, issue)

  const shownDocument = rendered?.document ?? ''
  const revision = rendered?.revision ?? 0
  const onEvent = useCallback<PluginDeclarativeEmit>(
    (callback, args, emitOptions = {}) => {
      // A press on Orca's own control is real input the guest never sees; it may grant a gesture.
      if (emitOptions.press && !admitPress(emitOptions.press)) {
        return
      }
      // Names the tree on screen, so the guest runs exactly the handler the person saw.
      sendToGuest(PLUGIN_DECLARATIVE_MESSAGES.event, {
        document: shownDocument,
        revision,
        callback,
        args,
        ...(emitOptions.edit === undefined ? {} : { edit: emitOptions.edit })
      })
    },
    [admitPress, revision, sendToGuest, shownDocument]
  )
  const { viewEpoch, trackHostCall } = usePluginPanelActDriver({
    tabKey,
    tree: rendered?.tree ?? null,
    document: rendered?.document ?? null,
    send: onEvent,
    sendToGuest
  })
  usePluginFrameHost({
    surface: 'panel',
    frameRef,
    frameKey,
    sessionToken,
    declarative: channel,
    consumeHostActivation: consumePress,
    trackHostCall,
    onUnresponsive
  })
  // A click on Orca's own Link (or a Markdown link): no frame-activation check, but its control
  // must have settled, and main keeps the URL allowlist and rate limit.
  const onOpenLink = (href: string, gestureId: string): void => {
    const token = sessionTokenRef.current
    if (token && isGestureSettled(gestureId)) {
      void callPanelActionViaPreload({
        sessionToken: token,
        action: PLUGIN_FRAME_USER_METHODS.openExternal,
        params: { url: href }
      })
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PluginFrameView
        // A dev save's new guest URL is a new webview; the tree below stays until it renders.
        key={frameKey}
        frameRef={frameRef}
        guest={guest}
        hidden
        name=""
        srcDoc=""
        onLoad={() => {}}
        title={title}
      />
      {issue ? (
        <PluginDeclarativeIssueNotice
          issue={issue}
          title={title}
          showingLastGood={rendered !== null}
          onDismiss={dismissIssue}
        />
      ) : null}
      {reloads > 0 ? <PluginDeclarativeReloadedNotice key={reloads} /> : null}
      <PluginDeclarativeView
        // A new guest document starts its value controls' edit counts over; so does a --act restore.
        key={`${shownDocument}:${viewEpoch}`}
        tree={rendered?.tree ?? null}
        onEvent={onEvent}
        onOpenLink={onOpenLink}
        onLoadImage={loadImage}
        gestures={gestures}
      />
    </div>
  )
}
