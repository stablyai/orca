// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPluginPanelShellHtml } from './plugin-panel-shell'

type Disposable = { dispose: () => void }
type FrameOrca = {
  on: (event: string, handler: (payload: unknown) => unknown) => Disposable
  plugin: {
    request: (name: string, input?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>
    on: (event: string, handler: (payload: unknown) => unknown) => Disposable
  }
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    onDidChange: (handler: (change: { key: string }) => void) => Disposable
  }
  settings: { get: (key?: string) => Promise<unknown> }
}

const realParent = window.parent
afterEach(() => {
  Object.defineProperty(window, 'parent', { value: realParent, configurable: true })
})

function mountShell() {
  const parent = { postMessage: vi.fn() }
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
  const script = buildPluginPanelShellHtml('<main></main>').match(
    /<script>\n([\s\S]*?)<\/script>/
  )?.[1]
  window.eval(script!.replaceAll('configurable: false', 'configurable: true'))
  const orca: FrameOrca = Object.getOwnPropertyDescriptor(window, 'orca')?.value
  const fromHost = (data: unknown) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shim only compares source identity.
    window.dispatchEvent(new MessageEvent('message', { data, source: parent as never as Window }))
  const requests = () =>
    parent.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.kind === 'req')
  const answer = (id: number, result: unknown) => fromHost({ orca: 1, kind: 'res', id, result })
  const push = (payload: unknown) =>
    fromHost({ orca: 1, kind: 'evt', event: 'plugin.push', payload })
  return { orca, requests, answer, push }
}

describe('window.orca.plugin', () => {
  it('asks the worker through plugin.request and resolves with its output', async () => {
    const { orca, requests, answer } = mountShell()
    const todos = orca.plugin.request('todos.list', { done: false }, { timeoutMs: 999_999 })
    const [sent] = requests()
    expect(sent).toMatchObject({
      method: 'plugin.request',
      params: { name: 'todos.list', input: { done: false }, timeoutMs: 120_000 }
    })
    answer(sent.id, { output: [{ id: '1' }] })
    await expect(todos).resolves.toEqual([{ id: '1' }])
  })

  it('hands worker posts to plugin.on by event name', () => {
    const { orca, push } = mountShell()
    const changed = vi.fn()
    const other = vi.fn()
    orca.plugin.on('todos.changed', changed)
    orca.plugin.on('other', other)
    push({ kind: 'message', event: 'todos.changed', payload: { count: 3 } })
    expect(changed).toHaveBeenCalledWith({ count: 3 })
    expect(other).not.toHaveBeenCalled()
  })
})

describe('window.orca events and data', () => {
  it('subscribes to a workspace or agent event once, on the first listener', () => {
    const { orca, requests, push } = mountShell()
    const first = vi.fn()
    orca.on('agent.status.changed', first)
    orca.on('agent.status.changed', vi.fn())
    orca.on('theme', vi.fn())
    expect(requests()).toEqual([
      expect.objectContaining({
        method: 'events.subscribe',
        params: { event: 'agent.status.changed' }
      })
    ])
    push({ kind: 'event', event: 'agent.status.changed', payload: { state: 'done' } })
    expect(first).toHaveBeenCalledWith({ state: 'done' })
  })

  it('reads storage and settings, and hears which key changed', async () => {
    const { orca, requests, answer, push } = mountShell()
    const value = orca.storage.get('todos')
    const setting = orca.settings.get('apiUrl')
    const [get, settings] = requests()
    answer(get.id, { value: null })
    answer(settings.id, { settings: { apiUrl: 'https://x' } })
    await expect(value).resolves.toBeNull()
    await expect(setting).resolves.toBe('https://x')
    const changed = vi.fn()
    orca.storage.onDidChange(changed)
    push({ kind: 'changed', area: 'settings', key: 'apiUrl' })
    push({ kind: 'changed', area: 'storage', key: 'todos' })
    expect(changed).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledWith({ key: 'todos' })
  })
})
