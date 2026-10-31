import { describe, expect, it, vi } from 'vitest'
import { isPluginJsonObject } from '../../../../shared/plugins/manifest/plugin-json-object'
import type { PluginHostCallOutcome } from '../../../../shared/plugins/frames/plugin-protocol'
import {
  createPanelMessageBudget,
  type PanelMessageBudget
} from '../../../../shared/plugins/frames/plugin-panel-message-budget'
import { createPluginFrameMessageHandler, type PluginFrameHostOptions } from './plugin-frame-host'

vi.mock('./plugin-panel-design-token-css', () => ({
  currentPluginFrameTheme: () => ({ colorScheme: 'dark', tokens: '--orca-background:#000' })
}))

type FakeFrameWindow = Window & { postMessage: ReturnType<typeof vi.fn> }

function createFakeFrameWindow(): FakeFrameWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host only calls postMessage.
  return { postMessage: vi.fn() } as unknown as FakeFrameWindow
}

function messageEvent(data: unknown, source: unknown): MessageEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only data/source are read; no DOM in this suite.
  return { data, source } as unknown as MessageEvent
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const req = (id: number, method = 'notifications.show', params: unknown = { title: 'hi' }) => ({
  orca: 1,
  kind: 'req',
  id,
  method,
  params
})
const pong = (payload: unknown, extra: Record<string, unknown> = {}) => ({
  orca: 1,
  kind: 'evt',
  event: 'pong',
  payload,
  ...extra
})
const SESSION_TOKEN = 's'.repeat(43)

function createHandler(
  frameWindow: FakeFrameWindow,
  overrides: Partial<PluginFrameHostOptions> & { outcome?: PluginHostCallOutcome } = {}
) {
  const callHostMethod = vi
    .fn()
    .mockResolvedValue(overrides.outcome ?? { ok: true, value: { delivered: true } })
  const handler = createPluginFrameMessageHandler({
    surface: 'panel',
    getFrameWindow: () => frameWindow,
    getSessionToken: () => SESSION_TOKEN,
    callHostMethod,
    ...overrides
  })
  return { handler, callHostMethod }
}

describe('createPluginFrameMessageHandler', () => {
  it('relays a request and answers with the same id', async () => {
    const frame = createFakeFrameWindow()
    const { handler, callHostMethod } = createHandler(frame)

    handler(messageEvent(req(1), frame))
    await flush()

    expect(callHostMethod).toHaveBeenCalledWith({
      sessionToken: SESSION_TOKEN,
      action: 'notifications.show',
      params: { title: 'hi' }
    })
    expect(frame.postMessage).toHaveBeenCalledWith(
      { orca: 1, kind: 'res', id: 1, result: { delivered: true } },
      '*'
    )
  })

  it('answers ready with hello: api, the surface methods and the theme', () => {
    const frame = createFakeFrameWindow()
    const onReady = vi.fn()
    const editor = { claim: () => false, onReady, onEvent: vi.fn(), onResponse: vi.fn() }
    const { handler } = createHandler(frame, { surface: 'editor', editor })

    handler(messageEvent({ orca: 1, kind: 'evt', event: 'ready', payload: { protocol: 1 } }, frame))

    const [hello] = frame.postMessage.mock.calls[0]!
    expect(hello).toMatchObject({
      orca: 1,
      kind: 'evt',
      event: 'hello',
      payload: {
        protocol: 1,
        surface: 'editor',
        api: { major: 1, minor: 0 },
        theme: { colorScheme: 'dark', tokens: '--orca-background:#000' }
      }
    })
    expect(hello.payload.methods).toContain('notifications.show')
    expect(hello.payload.methods).not.toContain('storage.get')
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('ignores messages from other windows and non-envelope traffic', async () => {
    const frame = createFakeFrameWindow()
    const { handler, callHostMethod } = createHandler(frame)

    handler(messageEvent(req(1), createFakeFrameWindow()))
    handler(messageEvent(req(1), null))
    handler(messageEvent({ type: 'react-devtools-bridge' }, frame))
    handler(messageEvent({ type: 'orca-panel-action', requestId: 'a', action: 'x' }, frame))
    await flush()

    expect(callHostMethod).not.toHaveBeenCalled()
    expect(frame.postMessage).not.toHaveBeenCalled()
  })

  it('relays a method it does not know, leaving the gate to main', async () => {
    const frame = createFakeFrameWindow()
    const { handler, callHostMethod } = createHandler(frame)
    handler(messageEvent(req(2, 'fs.readFile'), frame))
    await flush()
    expect(callHostMethod).toHaveBeenCalledTimes(1)
  })

  it('answers a malformed request with invalid_request', async () => {
    const frame = createFakeFrameWindow()
    const { handler, callHostMethod } = createHandler(frame)

    handler(messageEvent(req(3, 'x'.repeat(129)), frame))
    await flush()

    expect(callHostMethod).not.toHaveBeenCalled()
    expect(frame.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'res',
        id: 3,
        error: expect.objectContaining({ code: 'invalid_request', retryable: false })
      }),
      '*'
    )
  })

  it('refuses an oversized request with too_large', () => {
    const frame = createFakeFrameWindow()
    const { handler, callHostMethod } = createHandler(frame)

    handler(messageEvent(req(4, 'notifications.show', { padding: 'x'.repeat(128 * 1024) }), frame))

    expect(callHostMethod).not.toHaveBeenCalled()
    expect(frame.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 4, error: expect.objectContaining({ code: 'too_large' }) }),
      '*'
    )
  })

  it('rate limits with a retryable error that says when to retry', () => {
    const frame = createFakeFrameWindow()
    let clock = 1_000
    const { handler, callHostMethod } = createHandler(frame, {
      budget: createPanelMessageBudget({ maxMessages: 2, perMs: 10_000 }),
      now: () => clock
    })

    handler(messageEvent({ type: 'invalid-hostile-message' }, frame))
    clock += 4_000
    handler(messageEvent(pong(7), frame))
    handler(messageEvent(req(5), frame))

    expect(callHostMethod).not.toHaveBeenCalled()
    expect(frame.postMessage).toHaveBeenCalledWith(
      {
        orca: 1,
        kind: 'res',
        id: 5,
        error: {
          code: 'rate_limited',
          message: expect.any(String),
          retryable: true,
          retryAfterMs: 6_000
        }
      },
      '*'
    )
  })

  it('passes host error codes through and maps unknown ones to action_failed', async () => {
    const frame = createFakeFrameWindow()
    const { handler } = createHandler(frame, {
      outcome: { ok: false, code: 'capability_denied', error: 'no notifications:show' }
    })
    handler(messageEvent(req(6), frame))
    await flush()
    expect(frame.postMessage).toHaveBeenCalledWith(
      {
        orca: 1,
        kind: 'res',
        id: 6,
        error: { code: 'capability_denied', message: 'no notifications:show', retryable: false }
      },
      '*'
    )

    const legacy = createFakeFrameWindow()
    const { handler: legacyHandler } = createHandler(legacy, {
      // An older host's code this client does not know.
      callHostMethod: vi.fn().mockResolvedValue({ ok: false, code: 'panel_forbidden', error: 'no' })
    })
    legacyHandler(messageEvent(req(7), legacy))
    await flush()
    expect(legacy.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'action_failed' }) }),
      '*'
    )
  })

  it('reports a rejected relay as action_failed', async () => {
    const frame = createFakeFrameWindow()
    const { handler } = createHandler(frame, {
      callHostMethod: vi.fn().mockRejectedValue(new Error('ipc broke'))
    })
    handler(messageEvent(req(8), frame))
    await flush()
    expect(frame.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'action_failed', message: 'ipc broke' })
      }),
      '*'
    )
  })

  it('answers unavailable until main issues a session', async () => {
    const frame = createFakeFrameWindow()
    const { handler, callHostMethod } = createHandler(frame, { getSessionToken: () => null })
    handler(messageEvent(req(9), frame))
    await flush()
    expect(callHostMethod).not.toHaveBeenCalled()
    expect(frame.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 9,
        error: expect.objectContaining({ code: 'unavailable', retryable: true })
      }),
      '*'
    )
  })

  it('drops the answer to a call the frame cancelled', async () => {
    const frame = createFakeFrameWindow()
    let resolveCall!: (outcome: PluginHostCallOutcome) => void
    const { handler } = createHandler(frame, {
      callHostMethod: vi.fn(
        () => new Promise<PluginHostCallOutcome>((resolve) => (resolveCall = resolve))
      )
    })

    handler(messageEvent(req(10), frame))
    handler(messageEvent({ orca: 1, kind: 'cancel', id: 10 }, frame))
    resolveCall({ ok: true, value: { delivered: true } })
    await flush()

    expect(frame.postMessage).not.toHaveBeenCalled()
  })

  it('drops a deferred answer after the document is replaced', async () => {
    const frame = createFakeFrameWindow()
    let active = true
    let resolveCall!: (outcome: PluginHostCallOutcome) => void
    const { handler } = createHandler(frame, {
      isActive: () => active,
      callHostMethod: vi.fn(
        () => new Promise<PluginHostCallOutcome>((resolve) => (resolveCall = resolve))
      )
    })

    handler(messageEvent(req(11), frame))
    active = false
    resolveCall({ ok: true, value: { stale: true } })
    await flush()

    expect(frame.postMessage).not.toHaveBeenCalled()
  })

  it('keeps answering the watchdog while the data budget is saturated or flooded', () => {
    const frame = createFakeFrameWindow()
    const onPong = vi.fn()
    let clock = 0
    const { handler } = createHandler(frame, {
      onPong,
      now: () => clock
    })
    for (let i = 0; i < 500; i += 1) {
      handler(messageEvent(pong(i), frame))
      clock += 1
    }
    handler(messageEvent(pong(99), frame))
    expect(onPong).toHaveBeenLastCalledWith(99)

    const saturated = createHandler(frame, {
      onPong,
      budget: { maxBytes: 1024, admit: () => 'rate_limited' }
    })
    saturated.handler(messageEvent(pong(8), frame))
    expect(onPong).toHaveBeenLastCalledWith(8)
  })

  it('refuses an oversized frame on the reserved lane', () => {
    const frame = createFakeFrameWindow()
    const onPong = vi.fn()
    const { handler } = createHandler(frame, { onPong })
    handler(messageEvent(pong(7, { padding: 'x'.repeat(4 * 1024) }), frame))
    expect(onPong).not.toHaveBeenCalled()
  })

  it('routes editor traffic to the editor channel before the shared budget', () => {
    const frame = createFakeFrameWindow()
    const claim = vi.fn(
      (data: unknown) => isPluginJsonObject(data) && data.method === 'editor.applyEdit'
    )
    const onEvent = vi.fn()
    const onResponse = vi.fn()
    const admit = vi.fn<PanelMessageBudget['admit']>().mockReturnValue(null)
    const { handler, callHostMethod } = createHandler(frame, {
      surface: 'editor',
      budget: { maxBytes: 1024, admit },
      editor: { claim, onReady: vi.fn(), onEvent, onResponse }
    })

    handler(messageEvent(req(1, 'editor.applyEdit', {}), frame))
    handler(messageEvent({ orca: 1, kind: 'evt', event: 'editor.keydown', payload: {} }, frame))
    handler(messageEvent({ orca: 1, kind: 'res', id: 0, result: null }, frame))

    expect(admit).toHaveBeenCalledTimes(2)
    expect(callHostMethod).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'editor.keydown' }))
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ id: 0 }))
  })
})
