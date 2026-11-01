import React, { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { PLUGIN_DECLARATIVE_MESSAGES } from '../../../../shared/plugins/declarative/plugin-declarative-message-names'
import type { PluginFrameGuest } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { pluginEvent } from '../../../../shared/plugins/frames/plugin-protocol'
import { PLUGIN_FRAME_USER_METHODS } from '../../../../shared/plugins/workers/plugin-host-api'
import { PluginDeclarativeView } from '@/components/plugins/declarative/PluginDeclarativeView'
import { pluginDeclarativeGestureId } from '@/components/plugins/declarative/plugin-declarative-gesture-geometry'
import type { PluginDeclarativeEmit } from '@/components/plugins/declarative/PluginDeclarativeControls'
import { translate } from '@/i18n/i18n'
import { callPanelActionViaPreload } from './plugin-frame-host'
import {
  PluginFrameView,
  pluginFrameWindowOf,
  type PluginFrameElement
} from './plugin-frame-element'
import { usePluginFrameHost } from './use-plugin-frame-host'
import { usePluginDeclarativeTree } from './use-plugin-declarative-tree'
import { usePluginDeclarativeState } from './use-plugin-declarative-state'
import { useAppStore } from '@/store'

type PluginDeclarativePanelProps = {
  panelId: string
  title: string
  guest: PluginFrameGuest
  frameKey: string
  sessionToken: string | null
  onUnresponsive: () => void
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
  panelId,
  title,
  guest,
  frameKey,
  sessionToken,
  onUnresponsive
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
    sendToGuest
  })
  const {
    rendered,
    issue,
    channel,
    gestures,
    admitPress,
    consumePress,
    isGestureSettled,
    resetDocument
  } = usePluginDeclarativeTree(sendToGuest, {
    onGuestEvent: (event, payload) => state.onGuestEvent(event, payload)
  })
  // A reload or navigation brings a fresh runtime that counts revisions from 1 again.
  useEffect(() => {
    const frame = frameRef.current
    frame?.addEventListener('did-start-loading', resetDocument)
    return () => frame?.removeEventListener('did-start-loading', resetDocument)
  }, [resetDocument])
  const sessionTokenRef = useRef(sessionToken)
  useLayoutEffect(() => {
    sessionTokenRef.current = sessionToken
  })

  usePluginFrameHost({
    surface: 'panel',
    frameRef,
    frameKey,
    sessionToken,
    declarative: channel,
    consumeHostActivation: consumePress,
    onUnresponsive
  })

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
  // A click on Orca's own Link: no frame-activation check, but the Link must have settled, and
  // main keeps the URL allowlist and rate limit.
  const onOpenLink = (href: string): void => {
    const token = sessionTokenRef.current
    if (token && isGestureSettled(pluginDeclarativeGestureId.href(href))) {
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
        frameRef={frameRef}
        guest={guest}
        hidden
        name=""
        srcDoc=""
        onLoad={() => {}}
        title={title}
      />
      {issue ? (
        // Polite and plugin-attributed: this is the plugin's text, not an Orca failure.
        <div
          role="status"
          className="border-b border-border px-3 py-1.5 text-xs break-words text-muted-foreground"
        >
          {issue.source === 'plugin'
            ? translate(
                'auto.components.rightSidebar.PluginDeclarativePanel.pluginMessage',
                'Message from {{value0}}: {{value1}}',
                { value0: title, value1: issue.message }
              )
            : issue.message}
        </div>
      ) : null}
      <PluginDeclarativeView
        // A new guest document starts its value controls' edit counts over.
        key={shownDocument}
        tree={rendered?.tree ?? null}
        onEvent={onEvent}
        onOpenLink={onOpenLink}
        gestures={gestures}
      />
    </div>
  )
}
