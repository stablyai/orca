import {
  FRAME_EVENTS,
  PANEL_CONTROL_MESSAGE_MAX_BYTES,
  readPanelPongId
} from '../../../../shared/plugins/frames/plugin-frame-bridge'
import {
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
import { PLUGIN_DECLARATIVE_MESSAGES } from '../../../../shared/plugins/declarative/plugin-declarative-message-names'
import {
  createPanelControlMessageBudget,
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from '../../../../shared/plugins/frames/plugin-panel-message-budget'
import { translate } from '@/i18n/i18n'
import {
  createPluginFrameGestureGate,
  createPluginFrameLanes,
  PLUGIN_FRAME_RENDER_WALK_LIMITS,
  pluginFrameHello,
  pluginFrameLaneFor,
  type PluginFrameMessageContext,
  type PluginFrameWindow
} from './plugin-frame-host-lanes'

export {
  pluginFrameHello,
  pluginWebviewFrameWindow,
  type PluginFrameMessageContext,
  type PluginFrameWindow
} from './plugin-frame-host-lanes'

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
  onEvent: (event: PluginEvent, context: PluginFrameMessageContext) => void
  onResponse: (response: PluginResponse) => void
}

/** A declarative panel's tree traffic; payloads are unparsed, the panel validates them. */
export type PluginFrameDeclarativeChannel = {
  onRender: (payload: unknown) => void
  onError: (payload: unknown) => void
  /** Any other `ui.*` message from the guest (state requests and writes), unvalidated. */
  onGuestEvent?: (event: string, payload: unknown) => void
  /** A render refused by its lane budget; `retryAfterMs` is null when retrying cannot help. */
  onRefused?: (message: unknown, retryAfterMs: number | null) => void
}

export type PluginFrameHostOptions = {
  surface: 'panel' | 'editor'
  declarative?: PluginFrameDeclarativeChannel
  getFrameWindow: () => PluginFrameWindow | null
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
  /** `files.saveAs` lane; defaults to 64 MiB, a few per window. */
  saveBudget?: PanelMessageBudget
  /** `ui.render` lane: trees up to the declarative cap, re-rendered as the person types. */
  renderBudget?: PanelMessageBudget
  /** One-shot activation from a press on Orca's own controls (declarative panels). */
  consumeHostActivation?: () => boolean
  /** Called as a host call (`plugin.request` included) starts; the result runs when it settles. */
  trackHostCall?: () => () => void
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

/** The srcdoc iframe path: a window `message` listener that only trusts the frame's own Window. */
export function createPluginFrameMessageHandler(
  options: PluginFrameHostOptions
): (event: MessageEvent) => void {
  const handle = createPluginFrameEnvelopeHandler(options)
  return (event: MessageEvent): void => {
    // Sandboxed srcdoc has null origin; validate the sending Window identity instead of event.origin.
    if (!event.source || event.source !== options.getFrameWindow()) {
      return
    }
    // Activation in a child frame also activates this window, so the host can read it directly.
    // Activation in a child frame also activates this window; good enough for save chords, but
    // typing anywhere in Orca sets it too, so user-gesture methods never trust it.
    handle(event.data, {
      userActivation: navigator.userActivation?.isActive === true,
      transport: 'iframe'
    })
  }
}

/** One handler for panel and editor frames on either transport: liveness, hello, host calls with
 *  cancel, editor traffic. Callers have already verified the message came from this frame. */
export function createPluginFrameEnvelopeHandler(
  options: PluginFrameHostOptions
): (data: unknown, context: PluginFrameMessageContext) => void {
  const budget = options.budget ?? createPanelMessageBudget()
  const controlBudget = options.controlBudget ?? createPanelControlMessageBudget()
  const lanes = createPluginFrameLanes({ save: options.saveBudget, render: options.renderBudget })
  const now = options.now ?? (() => Date.now())
  const callHostMethod = options.callHostMethod ?? callPanelActionViaPreload
  // Ids the frame cancelled while main was still running the call; their answers are dropped.
  const inFlight = new Set<number>()
  // A components panel's hidden guest never has a real press of its own; only Orca's grant counts.
  const admitsGesture = createPluginFrameGestureGate(
    options.declarative ? (options.consumeHostActivation ?? (() => false)) : undefined
  )
  return (data: unknown, context: PluginFrameMessageContext): void => {
    const frameWindow = options.getFrameWindow()
    if (!frameWindow) {
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
    const pongId = readPanelPongId(data)
    if (pongId !== null) {
      const timestamp = now()
      // One size walk at the smaller lane cap serves both budgets; larger pongs are refused.
      const pongBytes = structuredCloneMessageBytes(
        data,
        controlBudget.maxBytes ?? PANEL_CONTROL_MESSAGE_MAX_BYTES
      )
      // Meter data traffic too, but data refusal alone must not silence liveness.
      budget.admit(timestamp, pongBytes)
      if (!controlBudget.admit(timestamp, pongBytes)) {
        options.onPong?.(pongId)
      }
      return
    }
    if (options.editor?.claim(data)) {
      return
    }
    // Budget before schema parsing so malformed floods cannot consume unmetered validation CPU.
    const timestamp = now()
    const lane = pluginFrameLaneFor(data, lanes, budget)
    const walk = lane === lanes.render ? PLUGIN_FRAME_RENDER_WALK_LIMITS : undefined
    const refusal = lane.admit(timestamp, structuredCloneMessageBytes(data, lane.maxBytes, walk))
    if (refusal) {
      if (lane === lanes.render) {
        options.declarative?.onRefused?.(
          data,
          refusal === 'oversized' ? null : (lane.retryAfterMs?.(timestamp) ?? 0)
        )
      }
      const id = pluginRequestId(data)
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
                  lane.retryAfterMs?.(timestamp)
                )
          )
        )
      }
      return
    }
    const message = readPluginEnvelope(data)
    if (!message) {
      const id = pluginRequestId(data)
      if (id !== null) {
        post(pluginFailure(id, pluginError('invalid_request', 'malformed request envelope')))
      }
      return
    }
    switch (message.kind) {
      case 'evt':
        if (message.event === FRAME_EVENTS.ready) {
          post(
            pluginEvent(FRAME_EVENTS.hello, pluginFrameHello(options.surface, context.transport))
          )
          options.editor?.onReady()
        } else if (message.event === PLUGIN_DECLARATIVE_MESSAGES.render) {
          options.declarative?.onRender(message.payload)
        } else if (message.event === PLUGIN_DECLARATIVE_MESSAGES.error) {
          options.declarative?.onError(message.payload)
        } else if (options.declarative && message.event.startsWith('ui.')) {
          options.declarative.onGuestEvent?.(message.event, message.payload)
        } else {
          // A guest's shell-posted chords are page-forgeable; only the preload's count there.
          if (context.transport !== 'guest' || context.trustedChord === true) {
            options.editor?.onEvent(message, context)
          }
        }
        return
      case 'res':
        options.editor?.onResponse(message)
        return
      case 'cancel':
        inFlight.delete(message.id)
        return
      case 'req':
        relayHostCall(message, post, context)
    }
  }

  function relayHostCall(
    request: PluginRequest,
    post: (message: PluginEnvelope) => void,
    context: PluginFrameMessageContext
  ): void {
    const respond = (response: PluginResponse): void => {
      if (inFlight.delete(request.id)) {
        post(response)
      }
    }
    const sessionToken = options.getSessionToken()
    inFlight.add(request.id)
    // Why here: frame code can post raw envelopes, so the shell's own check is only a fast path.
    if (!admitsGesture(request.method, context)) {
      respond(
        pluginFailure(
          request.id,
          pluginError('not_permitted', `${request.method} needs a click or key press in the frame`)
        )
      )
      return
    }
    if (!sessionToken) {
      respond(pluginFailure(request.id, pluginError('unavailable', 'plugin session is not ready')))
      return
    }
    const settled = options.trackHostCall?.()
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
      .finally(() => settled?.())
  }
}
