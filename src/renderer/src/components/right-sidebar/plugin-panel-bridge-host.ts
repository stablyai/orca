import {
  PANEL_ACTION_RESULT_TYPE,
  looksLikePanelActionRequest,
  looksLikePanelPong,
  parsePanelActionRequest,
  type PluginPanelActionOutcome,
  type PluginPanelActionResultMessage
} from '../../../../shared/plugins/plugin-panel-bridge'
import {
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from '../../../../shared/plugins/plugin-panel-message-budget'
import { translate } from '@/i18n/i18n'

/**
 * Host side of the plugin panel postMessage bridge. Framework-free so
 * message validation, budgets, and relay behavior are directly
 * unit-testable; PluginPanel wires the returned listener to `window` while
 * the panel iframe is mounted.
 *
 * Main issues an opaque session while loading the mounted panel. The guest
 * never sees or supplies plugin identity, and main binds the session again.
 */

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
  now?: () => number
}

/** Relays a bridge call through the preload API, degrading to a bridge-level
 *  error when the preload predates the plugins.panelAction surface. */
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
  const now = options.now ?? (() => Date.now())
  return (event: MessageEvent): void => {
    const panelWindow = options.getPanelWindow()
    // Why: the sandboxed srcdoc frame has an opaque origin ("null"), so the
    // sending window's identity — not event.origin — is the only trustworthy
    // check that this message came from our panel and not another frame.
    if (!panelWindow || event.source !== panelWindow) {
      return
    }
    const requestingWindow = panelWindow
    const respond = (message: PluginPanelActionResultMessage): void => {
      if (options.isActive?.() === false || options.getPanelWindow() !== requestingWindow) {
        return
      }
      // Why: targetOrigin must be '*' — an opaque origin never matches a
      // concrete origin, so anything stricter would silently drop the reply.
      requestingWindow.postMessage(message, '*')
    }
    // Budgets run before parsing: a flood of malformed junk must not buy
    // free schema-validation CPU either.
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
    if (looksLikePanelPong(event.data)) {
      options.onPong?.((event.data as { pingId: number }).pingId)
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
