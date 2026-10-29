import {
  FRAME_EVENTS,
  PANEL_CONTROL_MESSAGE_MAX_BYTES,
  readPanelPongId,
  type PluginFrameHello
} from '../../../../shared/plugins/frames/plugin-frame-bridge'
import {
  PLUGIN_PROTOCOL_VERSION,
  pluginError,
  pluginEvent,
  pluginFailure,
  pluginOutcomeResponse,
  pluginRequestId,
  readPluginEnvelope,
  type PluginEnvelope,
  type PluginEvent,
  type PluginHostCallOutcome,
  type PluginRequest,
  type PluginResponse
} from '../../../../shared/plugins/frames/plugin-protocol'
import {
  PLUGIN_HOST_API_MINOR,
  pluginHostMethodsFor
} from '../../../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_HOST_API_MAJOR } from '../../../../shared/plugins/workers/plugin-host-api-major'
import {
  createPanelControlMessageBudget,
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from '../../../../shared/plugins/frames/plugin-panel-message-budget'
import { translate } from '@/i18n/i18n'
import { currentPluginFrameTheme } from './plugin-panel-design-token-css'

/** Main binds opaque frame sessions; frames never supply plugin identity. */

export type PanelActionCall = {
  sessionToken: string
  action: string
  params?: unknown
}

/** A custom editor's document channel, riding the same frame. */
export type PluginFrameEditorChannel = {
  /** Claims a message before the shared budget (edits have their own); true when handled. */
  claim: (data: unknown) => boolean
  onReady: () => void
  onEvent: (event: PluginEvent) => void
  onResponse: (response: PluginResponse) => void
}

export type PluginFrameHostOptions = {
  surface: 'panel' | 'editor'
  getFrameWindow: () => Window | null
  /** Null until main issues one; host calls answer `unavailable` meanwhile. */
  getSessionToken: () => string | null
  callHostMethod?: (call: PanelActionCall) => Promise<PluginHostCallOutcome>
  /** False once the frame document/session has been replaced. */
  isActive?: () => boolean
  onPong?: (pingId: number) => void
  editor?: PluginFrameEditorChannel
  /** Injectable for tests; defaults to the shared per-plugin budget. */
  budget?: PanelMessageBudget
  /** Reserved liveness budget; defaults to the shared control-frame budget. */
  controlBudget?: PanelMessageBudget
  now?: () => number
}

/** Return a bridge error when older preloads lack plugins.panelAction. */
export function callPanelActionViaPreload(call: PanelActionCall): Promise<PluginHostCallOutcome> {
  const panelAction = window.api?.plugins?.panelAction
  if (!panelAction) {
    return Promise.resolve({
      ok: false,
      code: 'unavailable',
      error: translate(
        'auto.components.rightSidebar.pluginPanelBridgeHost.actionsUnavailable',
        'Plugin actions are not available in this client.'
      )
    })
  }
  return panelAction(call)
}

export function pluginFrameHello(surface: 'panel' | 'editor'): PluginFrameHello {
  return {
    protocol: PLUGIN_PROTOCOL_VERSION,
    surface,
    api: { major: PLUGIN_HOST_API_MAJOR, minor: PLUGIN_HOST_API_MINOR },
    methods: pluginHostMethodsFor(surface),
    theme: currentPluginFrameTheme()
  }
}

/** One listener for panel and editor frames: liveness, hello, host calls with cancel, editor traffic. */
export function createPluginFrameMessageHandler(
  options: PluginFrameHostOptions
): (event: MessageEvent) => void {
  const budget = options.budget ?? createPanelMessageBudget()
  const controlBudget = options.controlBudget ?? createPanelControlMessageBudget()
  const now = options.now ?? (() => Date.now())
  const callHostMethod = options.callHostMethod ?? callPanelActionViaPreload
  // Ids the frame cancelled while main was still running the call; their answers are dropped.
  const inFlight = new Set<number>()
  return (event: MessageEvent): void => {
    const frameWindow = options.getFrameWindow()
    // Sandboxed srcdoc has null origin; validate the sending Window identity instead of event.origin.
    if (!frameWindow || event.source !== frameWindow) {
      return
    }
    const post = (message: PluginEnvelope): void => {
      if (options.isActive?.() === false || options.getFrameWindow() !== frameWindow) {
        return
      }
      // Opaque origins require targetOrigin=*; concrete origins would silently drop replies.
      frameWindow.postMessage(message, '*')
    }
    // Reserve liveness for schema-valid pongs so saturated data traffic or malformed near-pongs cannot silence the watchdog.
    const pongId = readPanelPongId(event.data)
    if (pongId !== null) {
      const timestamp = now()
      // One size walk at the smaller lane cap serves both budgets; larger pongs are refused.
      const pongBytes = structuredCloneMessageBytes(
        event.data,
        controlBudget.maxBytes ?? PANEL_CONTROL_MESSAGE_MAX_BYTES
      )
      // Meter data traffic too, but data refusal alone must not silence liveness.
      budget.admit(timestamp, pongBytes)
      if (!controlBudget.admit(timestamp, pongBytes)) {
        options.onPong?.(pongId)
      }
      return
    }
    if (options.editor?.claim(event.data)) {
      return
    }
    // Budget before schema parsing so malformed floods cannot consume unmetered validation CPU.
    const timestamp = now()
    const refusal = budget.admit(
      timestamp,
      structuredCloneMessageBytes(event.data, budget.maxBytes)
    )
    if (refusal) {
      const id = pluginRequestId(event.data)
      if (id !== null) {
        post(
          pluginFailure(
            id,
            refusal === 'oversized'
              ? pluginError(
                  'too_large',
                  translate(
                    'auto.components.rightSidebar.pluginPanelBridgeHost.messageTooLarge',
                    'Message exceeds the size limit.'
                  )
                )
              : pluginError(
                  'rate_limited',
                  translate(
                    'auto.components.rightSidebar.pluginPanelBridgeHost.tooManyRequests',
                    'Too many requests.'
                  ),
                  budget.retryAfterMs?.(timestamp)
                )
          )
        )
      }
      return
    }
    const message = readPluginEnvelope(event.data)
    if (!message) {
      const id = pluginRequestId(event.data)
      if (id !== null) {
        post(pluginFailure(id, pluginError('invalid_request', 'malformed request envelope')))
      }
      return
    }
    switch (message.kind) {
      case 'evt':
        if (message.event === FRAME_EVENTS.ready) {
          post(pluginEvent(FRAME_EVENTS.hello, pluginFrameHello(options.surface)))
          options.editor?.onReady()
        } else {
          options.editor?.onEvent(message)
        }
        return
      case 'res':
        options.editor?.onResponse(message)
        return
      case 'cancel':
        inFlight.delete(message.id)
        return
      case 'req':
        relayHostCall(message, post)
    }
  }

  function relayHostCall(request: PluginRequest, post: (message: PluginEnvelope) => void): void {
    const respond = (response: PluginResponse): void => {
      if (inFlight.delete(request.id)) {
        post(response)
      }
    }
    const sessionToken = options.getSessionToken()
    inFlight.add(request.id)
    if (!sessionToken) {
      respond(pluginFailure(request.id, pluginError('unavailable', 'plugin session is not ready')))
      return
    }
    callHostMethod({ sessionToken, action: request.method, params: request.params })
      .then((outcome) => respond(pluginOutcomeResponse(request.id, outcome)))
      .catch((error: unknown) =>
        respond(
          pluginFailure(
            request.id,
            pluginError('action_failed', error instanceof Error ? error.message : String(error))
          )
        )
      )
  }
}
