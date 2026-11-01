import { describe, expect, it, vi } from 'vitest'
import { parsePluginDeclarativeTree } from '../../../../shared/plugins/declarative/plugin-declarative-tree'
import {
  createPluginFrameEnvelopeHandler,
  pluginWebviewFrameWindow,
  type PluginFrameHostOptions
} from './plugin-frame-host'

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

function chain(depth: number): unknown {
  let tree: unknown = { type: 'Text', key: '#0', props: {}, children: ['leaf'] }
  for (let level = 1; level < depth; level++) {
    tree = { type: 'Stack', key: '#0', props: { gap: 'sm' }, children: [tree] }
  }
  return tree
}

describe('declarative render lane', () => {
  it.each([
    ['a chain at the depth limit', chain(64)],
    [
      'thousands of siblings',
      {
        type: 'Stack',
        key: '#0',
        props: {},
        children: Array.from({ length: 4000 }, (_, index) => ({
          type: 'Separator',
          key: `#${index}`,
          props: {},
          children: []
        }))
      }
    ]
  ])('meters %s instead of refusing it', (_label, tree) => {
    expect(parsePluginDeclarativeTree(tree).ok).toBe(true)
    const { render, onRender, onRefused } = declarativeGuest()
    render(tree)
    expect(onRefused).not.toHaveBeenCalled()
    expect(onRender).toHaveBeenCalledOnce()
  })

  it('reports an oversized render as refused, without retry', () => {
    const { render, onRender, onRefused } = declarativeGuest()
    render({ type: 'Text', props: {}, children: ['x'.repeat(700 * 1024)] }, 9)
    expect(onRender).not.toHaveBeenCalled()
    expect(onRefused).toHaveBeenCalledWith(expect.objectContaining({ event: 'ui.render' }), null)
  })

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

  it('tracks each relayed host call until it settles, so a shot can wait for the worker', async () => {
    let answer = (_value: unknown): void => {}
    const callHostMethod = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockRejectedValueOnce(new Error('ipc broke'))
    let pending = 0
    const trackHostCall = () => {
      pending += 1
      return () => {
        pending -= 1
      }
    }
    const { handle } = declarativeGuest({ callHostMethod, trackHostCall })
    const request = (id: number, method: string) => ({ orca: 1, kind: 'req', id, method })
    handle(request(1, 'plugin.request'), guestContext)
    handle(request(2, 'storage.get'), guestContext)
    // Refused before it reaches main: nothing to wait for.
    handle(request(3, 'shell.openExternal'), guestContext)
    expect(pending).toBe(2)
    await flush()
    expect(pending).toBe(1)
    answer({ ok: true, value: 1 })
    await flush()
    expect(pending).toBe(0)
  })
})
