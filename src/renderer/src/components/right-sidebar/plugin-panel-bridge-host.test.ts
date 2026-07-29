import { describe, expect, it, vi } from 'vitest'
import type { PluginPanelActionOutcome } from '../../../../shared/plugins/plugin-panel-bridge'
import {
  createPanelMessageBudget,
  type PanelMessageBudget
} from '../../../../shared/plugins/plugin-panel-message-budget'
import { createPanelBridgeMessageHandler } from './plugin-panel-bridge-host'

type FakePanelWindow = Window & { postMessage: ReturnType<typeof vi.fn> }

function createFakePanelWindow(): FakePanelWindow {
  return { postMessage: vi.fn() } as unknown as FakePanelWindow
}

function messageEvent(data: unknown, source: unknown): MessageEvent {
  // The handler only reads .data and .source, so a plain object stands in for
  // a real MessageEvent without needing a DOM environment.
  return { data, source } as unknown as MessageEvent
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const VALID_DATA = {
  type: 'orca-panel-action',
  requestId: 'req-1',
  action: 'terminal.sendText',
  params: { terminalId: 'term-1', text: '/model haiku', enter: true }
}
const SESSION_TOKEN = 's'.repeat(43)

function createHandler(
  panelWindow: FakePanelWindow,
  outcome: PluginPanelActionOutcome = { ok: true, value: { accepted: true } }
): { handler: (event: MessageEvent) => void; callPanelAction: ReturnType<typeof vi.fn> } {
  const callPanelAction = vi.fn().mockResolvedValue(outcome)
  const handler = createPanelBridgeMessageHandler({
    sessionToken: SESSION_TOKEN,
    getPanelWindow: () => panelWindow,
    callPanelAction
  })
  return { handler, callPanelAction }
}

describe('createPanelBridgeMessageHandler', () => {
  it('relays a valid request and posts the success result back into the panel', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelAction } = createHandler(panelWindow)

    handler(messageEvent(VALID_DATA, panelWindow))
    await flush()

    expect(callPanelAction).toHaveBeenCalledWith({
      sessionToken: SESSION_TOKEN,
      action: 'terminal.sendText',
      params: { terminalId: 'term-1', text: '/model haiku', enter: true }
    })
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'orca-panel-action-result',
        requestId: 'req-1',
        ok: true,
        value: { accepted: true }
      },
      '*'
    )
  })

  it('ignores messages whose source is not the panel iframe window', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelAction } = createHandler(panelWindow)

    handler(messageEvent(VALID_DATA, createFakePanelWindow()))
    handler(messageEvent(VALID_DATA, null))
    await flush()

    expect(callPanelAction).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).not.toHaveBeenCalled()
  })

  it('ignores unrelated window messages without replying', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelAction } = createHandler(panelWindow)

    handler(messageEvent({ type: 'react-devtools-bridge' }, panelWindow))
    handler(messageEvent('plain string', panelWindow))
    await flush()

    expect(callPanelAction).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).not.toHaveBeenCalled()
  })

  it('answers a malformed bridge request with invalid_request instead of relaying it', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelAction } = createHandler(panelWindow)

    handler(messageEvent({ ...VALID_DATA, action: 'fs.readFile' }, panelWindow))
    await flush()

    expect(callPanelAction).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-panel-action-result',
        requestId: 'req-1',
        ok: false,
        errorCode: 'invalid_request'
      }),
      '*'
    )
  })

  it('refuses an oversized request without relaying it', () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelAction } = createHandler(panelWindow)

    handler(
      messageEvent(
        {
          ...VALID_DATA,
          params: { padding: 'x'.repeat(128 * 1024) }
        },
        panelWindow
      )
    )

    expect(callPanelAction).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-panel-action-result',
        requestId: 'req-1',
        ok: false,
        errorCode: 'invalid_request'
      }),
      '*'
    )
  })

  it('refuses a valid request after malformed and pong traffic exhaust the budget', () => {
    const panelWindow = createFakePanelWindow()
    const callPanelAction = vi.fn()
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction,
      budget: createPanelMessageBudget({ maxMessages: 2 })
    })

    handler(messageEvent({ type: 'invalid-hostile-message' }, panelWindow))
    handler(messageEvent({ type: 'orca-panel-pong', pingId: 7 }, panelWindow))
    handler(messageEvent(VALID_DATA, panelWindow))

    expect(callPanelAction).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-panel-action-result',
        requestId: 'req-1',
        ok: false,
        errorCode: 'rate_limited'
      }),
      '*'
    )
  })

  it('relays a denial outcome (missing manifest permission) back to the panel', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler } = createHandler(panelWindow, {
      ok: false,
      code: 'capability_denied',
      error: 'plugin does not have the "terminal.sendText" permission'
    })

    handler(messageEvent(VALID_DATA, panelWindow))
    await flush()

    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'orca-panel-action-result',
        requestId: 'req-1',
        ok: false,
        errorCode: 'capability_denied',
        error: 'plugin does not have the "terminal.sendText" permission'
      },
      '*'
    )
  })

  it('reports a rejected relay call as action_failed', async () => {
    const panelWindow = createFakePanelWindow()
    const callPanelAction = vi.fn().mockRejectedValue(new Error('ipc broke'))
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction
    })

    handler(messageEvent(VALID_DATA, panelWindow))
    await flush()

    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCode: 'action_failed', error: 'ipc broke' }),
      '*'
    )
  })

  it('drops a deferred result after the requesting document is invalidated', async () => {
    const panelWindow = createFakePanelWindow()
    let active = true
    let resolveCall!: (outcome: PluginPanelActionOutcome) => void
    const callPanelAction = vi.fn(
      () => new Promise<PluginPanelActionOutcome>((resolve) => (resolveCall = resolve))
    )
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction,
      isActive: () => active
    })

    handler(messageEvent(VALID_DATA, panelWindow))
    active = false
    resolveCall({ ok: true, value: { stale: true } })
    await flush()

    expect(panelWindow.postMessage).not.toHaveBeenCalled()
  })

  it('charges every guest frame, pongs included, to the data budget', () => {
    const panelWindow = createFakePanelWindow()
    const admit = vi.fn<PanelMessageBudget['admit']>().mockReturnValue(null)
    const controlAdmit = vi.fn<PanelMessageBudget['admit']>().mockReturnValue(null)
    const onPong = vi.fn()
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction: vi.fn(),
      onPong,
      budget: { maxBytes: 1024, admit },
      controlBudget: { maxBytes: 1024, admit: controlAdmit }
    })

    handler(messageEvent({ type: 'invalid-hostile-message' }, panelWindow))
    handler(messageEvent({ type: 'orca-panel-pong', pingId: 7 }, panelWindow))

    // The pong spends data budget too, so the reserved lane grants liveness
    // without also granting a free channel for unmetered host work.
    expect(admit).toHaveBeenCalledTimes(2)
    expect(controlAdmit).toHaveBeenCalledTimes(1)
    expect(onPong).toHaveBeenCalledWith(7)
  })

  it('charges a near-miss pong to the data budget only, sparing the reserved lane', () => {
    const panelWindow = createFakePanelWindow()
    const admit = vi.fn<PanelMessageBudget['admit']>().mockReturnValue(null)
    const controlAdmit = vi.fn<PanelMessageBudget['admit']>().mockReturnValue(null)
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction: vi.fn(),
      onPong: vi.fn(),
      budget: { maxBytes: 1024, admit },
      controlBudget: { maxBytes: 1024, admit: controlAdmit }
    })

    handler(messageEvent({ type: 'orca-panel-pong', pingId: -1 }, panelWindow))
    handler(messageEvent({ type: 'orca-panel-pong', pingId: 'seven' }, panelWindow))
    handler(messageEvent({ type: 'orca-panel-pong' }, panelWindow))

    expect(admit).toHaveBeenCalledTimes(3)
    expect(controlAdmit).not.toHaveBeenCalled()
  })

  it('keeps answering the watchdog while the data budget is saturated', () => {
    const panelWindow = createFakePanelWindow()
    const onPong = vi.fn()
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction: vi.fn(),
      onPong,
      budget: { maxBytes: 1024, admit: () => 'rate_limited' }
    })

    handler(messageEvent({ type: 'orca-panel-pong', pingId: 7 }, panelWindow))

    expect(onPong).toHaveBeenCalledWith(7)
  })

  it('never lets a panel starve its own watchdog with self-sent pong traffic', () => {
    const panelWindow = createFakePanelWindow()
    const onPong = vi.fn()
    let clock = 0
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction: vi.fn(),
      onPong,
      now: () => clock
    })

    // A hostile panel floods unsolicited pongs, then the real watchdog reply
    // for this window arrives. Any per-window count on the reserved lane would
    // have been spent by the flood and would drop pingId 99.
    for (let i = 0; i < 500; i += 1) {
      handler(messageEvent({ type: 'orca-panel-pong', pingId: i }, panelWindow))
      clock += 1
    }
    handler(messageEvent({ type: 'orca-panel-pong', pingId: 99 }, panelWindow))

    expect(onPong).toHaveBeenLastCalledWith(99)
  })

  it('refuses an oversized frame on the reserved lane', () => {
    const panelWindow = createFakePanelWindow()
    const onPong = vi.fn()
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction: vi.fn(),
      onPong
    })

    handler(
      messageEvent(
        { type: 'orca-panel-pong', pingId: 7, padding: 'x'.repeat(4 * 1024) },
        panelWindow
      )
    )

    expect(onPong).not.toHaveBeenCalled()
  })
})
