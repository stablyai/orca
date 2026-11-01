import type { PluginFrameHello } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { PLUGIN_FRAME_IPC_CHANNEL } from '../../../../shared/plugins/frames/plugin-frame-guest'
import {
  createPanelMessageBudget,
  type PanelMessageBudget
} from '../../../../shared/plugins/frames/plugin-panel-message-budget'
import { PLUGIN_PROTOCOL_VERSION } from '../../../../shared/plugins/frames/plugin-protocol'
import { isPluginJsonObject } from '../../../../shared/plugins/manifest/plugin-json-object'
import {
  getPluginHostMethodSpec,
  PLUGIN_FRAME_USER_METHODS,
  PLUGIN_SAVE_AS_MAX_BYTES,
  pluginFrameMethodsFor,
  pluginHostApiMinorFor
} from '../../../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_HOST_API_MAJOR } from '../../../../shared/plugins/workers/plugin-host-api-major'
import { getIntlLocale } from '@/i18n/i18n'
import { currentPluginFrameTheme } from './plugin-panel-design-token-css'

/** Which channel a message came over; only a guest's activation stamp is trustworthy. */
export type PluginFrameTransport = 'iframe' | 'guest'

/** What the host knows about one frame message beyond its data. */
export type PluginFrameMessageContext = {
  /** The frame had transient user activation when it sent the message. */
  userActivation: boolean
  /** Defaults to `iframe`: user-gesture host methods run only for guests. */
  transport?: PluginFrameTransport
  /** Guests: the serial of the real input that activated the frame (0 for none). */
  gesture?: number
  /** Guests: a modifier chord the preload saw as trusted input, never page script. */
  trustedChord?: boolean
}

/** Where host replies go: an iframe's window, or a guest webview through its IPC channel. */
export type PluginFrameWindow = {
  postMessage: (message: unknown, targetOrigin: string, transfer?: Transferable[]) => void
}

/** The guest side of `webview.send`; IPC copies, so transfer lists are ignored. */
type PluginFrameWebview = { send: (channel: string, ...args: unknown[]) => void }

const webviewFrameWindows = new WeakMap<PluginFrameWebview, PluginFrameWindow>()

/** One stable adapter per guest, so sender identity checks keep working across calls. */
export function pluginWebviewFrameWindow(webview: PluginFrameWebview): PluginFrameWindow {
  let frameWindow = webviewFrameWindows.get(webview)
  if (!frameWindow) {
    frameWindow = {
      postMessage: (message) => {
        try {
          webview.send(PLUGIN_FRAME_IPC_CHANNEL, message)
        } catch {
          // Before dom-ready or after the guest died there is no one to answer.
        }
      }
    }
    webviewFrameWindows.set(webview, frameWindow)
  }
  return frameWindow
}

export function pluginFrameHello(
  surface: 'panel' | 'editor',
  transport: PluginFrameTransport = 'iframe'
): PluginFrameHello {
  const methods = pluginFrameMethodsFor(surface, transport === 'guest')
  return {
    protocol: PLUGIN_PROTOCOL_VERSION,
    surface,
    // Why derived: an iframe must not claim a minor whose methods it is never offered.
    api: { major: PLUGIN_HOST_API_MAJOR, minor: pluginHostApiMinorFor(methods) },
    methods,
    theme: currentPluginFrameTheme(),
    locale: getIntlLocale()
  }
}

/**
 * Whether a user-gesture method may run. A srcdoc iframe shares the host window, whose activation
 * any keystroke in Orca sets, so only a guest's isolated-world gesture serial counts, and each
 * serial admits one call: activation lasts seconds, a gesture is one click or key press.
 */
export function createPluginFrameGestureGate(): (
  method: string,
  context: PluginFrameMessageContext
) => boolean {
  let consumed = 0
  return (method, context) => {
    if (getPluginHostMethodSpec(method)?.userActivation !== true) {
      return true
    }
    const gesture = context.gesture ?? 0
    if (context.transport !== 'guest' || gesture <= consumed) {
      return false
    }
    consumed = gesture
    return true
  }
}

const SAVE_AS_LIMITS = { maxBytes: PLUGIN_SAVE_AS_MAX_BYTES + 4096, maxMessages: 5, perMs: 10_000 }

export type PluginFrameLanes = { save: PanelMessageBudget }

export function createPluginFrameLanes(
  overrides: Partial<PluginFrameLanes> = {}
): PluginFrameLanes {
  return { save: overrides.save ?? createPanelMessageBudget(SAVE_AS_LIMITS) }
}

/** Saves carry whole files, so they ride their own lane, not the 64 KiB one. */
export function pluginFrameLaneFor(
  data: unknown,
  lanes: PluginFrameLanes,
  shared: PanelMessageBudget
): PanelMessageBudget {
  if (!isPluginJsonObject(data)) {
    return shared
  }
  if (data.kind === 'req' && data.method === PLUGIN_FRAME_USER_METHODS.saveAs) {
    return lanes.save
  }
  return shared
}
