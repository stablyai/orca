import { describe, expect, it, vi } from 'vitest'

import { createPluginFrameEnvelopeHandler, type PluginFrameHostOptions } from './plugin-frame-host'
import { pluginWebviewFrameWindow } from './plugin-frame-host-lanes'

vi.mock('./plugin-panel-design-token-css', () => ({
  currentPluginFrameTheme: () => ({ colorScheme: 'dark', tokens: '' })
}))

const guestContext = { userActivation: true, transport: 'guest' as const }
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function declarativeGuest(overrides: Partial<PluginFrameHostOptions> = {}) {
  const webview = { send: vi.fn() }
  const onRender = vi.fn()
  const onRefused = vi.fn()
  const callHostMethod = vi.fn().mockResolvedValue({ ok: true, value: null })
  const handle = createPluginFrameEnvelopeHandler({
    surface: 'panel',
    getFrameWindow: () => pluginWebviewFrameWindow(webview),
    getSessionToken: () => 'token',
    callHostMethod,
    declarative: { onRender, onError: vi.fn(), onRefused },
    ...overrides
  })
  const render = (tree: unknown, revision = 1) =>
    handle({ orca: 1, kind: 'evt', event: 'ui.render', payload: { revision, tree } }, guestContext)
  return { handle, render, onRender, onRefused, callHostMethod, webview }
}

describe('declarative render lane', () => {
  it("ignores the hidden guest's own activation for user-gesture methods", async () => {
    const consumeHostActivation = vi.fn(() => false)
    const { handle, callHostMethod } = declarativeGuest({ consumeHostActivation })
    const open = (id: number) => ({
      orca: 1,
      kind: 'req',
      id,
      method: 'shell.openExternal',
      params: { url: 'https://example.com' }
    })
    handle(open(1), guestContext)
    await flush()
    expect(callHostMethod).not.toHaveBeenCalled()
    consumeHostActivation.mockReturnValue(true)
    handle(open(2), { userActivation: false, transport: 'guest' })
    await flush()
    expect(callHostMethod).toHaveBeenCalledOnce()
  })
})
