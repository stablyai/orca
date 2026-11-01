import React from 'react'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import type { PluginFrameGuest } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { isWebClientLocation } from '@/lib/web-client-location'
import { pluginWebviewFrameWindow, type PluginFrameWindow } from './plugin-frame-host'

/** A mounted plugin frame: a srcdoc `<iframe>` (browser clients) or an isolated `<webview>` guest. */
export type PluginFrameElement = HTMLElement

type GuestElement = HTMLElement & { send: (channel: string, ...args: unknown[]) => void }

function isGuestElement(element: HTMLElement): element is GuestElement {
  return element.tagName === 'WEBVIEW' && 'send' in element && typeof element.send === 'function'
}

export function pluginFrameWindowOf(element: PluginFrameElement | null): PluginFrameWindow | null {
  if (!element) {
    return null
  }
  if (element instanceof HTMLIFrameElement) {
    return element.contentWindow
  }
  return isGuestElement(element) ? pluginWebviewFrameWindow(element) : null
}

/** The guest preload sends `(envelope, userActivation)`; anything else on the element is ignored. */
export function readPluginGuestMessage(
  event: Event,
  channel: string
): { data: unknown; gesture: number } | null {
  if (!('channel' in event) || event.channel !== channel || !('args' in event)) {
    return null
  }
  const args = event.args
  if (!Array.isArray(args) || args.length === 0) {
    return null
  }
  // The preload's isolated-world stamp: `{ gesture }`, the serial of the input that activated it.
  const stamp: unknown = args[1]
  const gesture =
    typeof stamp === 'object' && stamp !== null && 'gesture' in stamp ? stamp.gesture : 0
  return {
    data: args[0],
    gesture:
      typeof gesture === 'number' && Number.isSafeInteger(gesture) && gesture > 0 ? gesture : 0
  }
}

/** Guests need Electron's `<webview>`; browser clients never receive a guest from main. */
export function usablePluginFrameGuest(
  guest: PluginFrameGuest | undefined
): PluginFrameGuest | null {
  return guest && !isWebClientLocation() ? guest : null
}

type PluginFrameViewProps = {
  frameRef: React.RefObject<PluginFrameElement | null>
  guest: PluginFrameGuest | null
  srcDoc: string
  name: string
  title: string
  onLoad: () => void
}

export function PluginFrameView({
  frameRef,
  guest,
  srcDoc,
  name,
  title,
  onLoad
}: PluginFrameViewProps): React.JSX.Element {
  const setFrame = (element: PluginFrameElement | null): void => {
    frameRef.current = element
  }
  if (guest) {
    return (
      // Main admits only this plugin's partition with this origin, and pins the guest's preload
      // and web preferences itself; these attributes are requests, not authority.
      <webview
        ref={setFrame}
        partition={guest.partition}
        webpreferences={ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE}
        src={guest.url}
        title={title}
        className="flex min-h-0 w-full flex-1 border-0 bg-background"
      />
    )
  }
  return (
    <iframe
      ref={setFrame}
      // SECURITY: never add allow-same-origin — the srcdoc frame must stay an
      // opaque origin so plugin UI cannot reach the app DOM, storage, or IPC.
      // The srcdoc itself is the host CSP shell wrapped around plugin HTML.
      sandbox="allow-scripts"
      name={name}
      srcDoc={srcDoc}
      onLoad={onLoad}
      title={title}
      className="min-h-0 w-full flex-1 border-0 bg-background"
    />
  )
}
