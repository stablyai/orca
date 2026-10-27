import {
  PANEL_ACTION_RESULT_TYPE,
  PANEL_CONTROL_MESSAGE_MAX_BYTES,
  looksLikePanelActionRequest,
  parsePanelActionRequest,
  readPanelPongId,
  type PluginPanelActionOutcome,
  type PluginPanelActionResultMessage
} from '../../../../shared/plugins/plugin-panel-bridge'
import {
  createPanelControlMessageBudget,
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from '../../../../shared/plugins/plugin-panel-message-budget'
import { translate } from '@/i18n/i18n'

/** Main binds opaque panel sessions; guests never supply plugin identity. PluginPanel mounts this framework-free postMessage listener. */

export type PanelActionCall = {
  sessionToken: string
  action: string
  params?: unknown
}

export type PanelBridgeHostOptions = {
  sessionToken: string
  /** The mounted panel iframe's contentWindow, or null when unmounted. */
  getPanelWindow: () => Window | null
  callPanelAction: (call: PanelActionCall) => Promise<PluginPanelActionOutcome>
  /** False once the requesting panel document/session has been replaced. */
  isActive?: () => boolean
  onPong?: (pingId: number) => void
  /** Injectable for tests; defaults to the shared per-plugin budget. */
  budget?: PanelMessageBudget
  /** Reserved liveness budget; defaults to the shared control-frame budget. */
  controlBudget?: PanelMessageBudget
  now?: () => number
}

/** Return a bridge error when older preloads lack plugins.panelAction. */
export function callPanelActionViaPreload(
  call: PanelActionCall
): Promise<PluginPanelActionOutcome> {
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

export function createPanelBridgeMessageHandler(
  options: PanelBridgeHostOptions
): (event: MessageEvent) => void {
  const budget = options.budget ?? createPanelMessageBudget()
  const controlBudget = options.controlBudget ?? createPanelControlMessageBudget()
  const now = options.now ?? (() => Date.now())
  return (event: MessageEvent): void => {
    const panelWindow = options.getPanelWindow()
    // Sandboxed srcdoc has null origin; validate the sending Window identity instead of event.origin.
    if (!panelWindow || event.source !== panelWindow) {
      return
    }
    const requestingWindow = panelWindow
    const respond = (message: PluginPanelActionResultMessage): void => {
      if (options.isActive?.() === false || options.getPanelWindow() !== requestingWindow) {
        return
      }
      // Opaque origins require targetOrigin=*; concrete origins would silently drop replies.
      requestingWindow.postMessage(message, '*')
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
    // Budget before schema parsing so malformed floods cannot consume unmetered validation CPU.
    const refusal = budget.admit(now(), structuredCloneMessageBytes(event.data, budget.maxBytes))
    if (refusal) {
      const requestId =
        typeof event.data === 'object' && event.data !== null
          ? (event.data as { requestId?: unknown }).requestId
          : undefined
      if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128) {
        respond({
          type: PANEL_ACTION_RESULT_TYPE,
          requestId,
          ok: false,
          errorCode: refusal === 'oversized' ? 'invalid_request' : 'rate_limited',
          error:
            refusal === 'oversized'
              ? translate(
                  'auto.components.rightSidebar.pluginPanelBridgeHost.messageTooLarge',
                  'Message exceeds the size limit.'
                )
              : translate(
                  'auto.components.rightSidebar.pluginPanelBridgeHost.tooManyRequests',
                  'Too many requests.'
                )
        })
      }
      return
    }
    if (!looksLikePanelActionRequest(event.data)) {
      return
    }
    const parsed = parsePanelActionRequest(event.data)
    if (!parsed.ok) {
      if (parsed.requestId) {
        respond({
          type: PANEL_ACTION_RESULT_TYPE,
          requestId: parsed.requestId,
          ok: false,
          errorCode: 'invalid_request',
          error: parsed.error
        })
      }
      return
    }
    const { requestId, action, params } = parsed.request
    options
      .callPanelAction({ sessionToken: options.sessionToken, action, params })
      .then((outcome) => {
        respond(
          outcome.ok
            ? { type: PANEL_ACTION_RESULT_TYPE, requestId, ok: true, value: outcome.value }
            : {
                type: PANEL_ACTION_RESULT_TYPE,
                requestId,
                ok: false,
                errorCode: outcome.code,
                error: outcome.error
              }
        )
      })
      .catch((error: unknown) => {
        respond({
          type: PANEL_ACTION_RESULT_TYPE,
          requestId,
          ok: false,
          errorCode: 'action_failed',
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }
}
