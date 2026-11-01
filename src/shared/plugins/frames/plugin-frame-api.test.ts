// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPluginGuestShellHtml,
  buildPluginPanelShellHtml,
  type PluginFrameSurface
} from './plugin-panel-shell'

/** The injected `window.orca` is the public frame API; the envelope under it stays internal. */

type FrameOrca = {
  api: { major: number; minor: number }
  host: {
    call: (method: string, params?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
    has: (method: string) => boolean
  }
  on: (event: string, handler: (payload: unknown) => unknown) => { dispose: () => void }
  locale: string
  plugin: object
  storage: object
  shell?: { openExternal: (url: string) => Promise<unknown> }
  files?: {
    saveAs: (options: {
      suggestedName?: string
      mimeType?: string
      data: unknown
    }) => Promise<unknown>
  }
  document?: {
    get: () => Promise<unknown>
    onDidChange: (handler: (document: unknown) => void) => { dispose: () => void }
    applyEdit: (edit: unknown) => Promise<unknown>
  }
}

const realParent = window.parent

afterEach(() => {
  Object.defineProperty(window, 'parent', { value: realParent, configurable: true })
})

function mountShell(surface: PluginFrameSurface = 'panel') {
  const parent = { postMessage: vi.fn() }
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
  const script = buildPluginPanelShellHtml('<main></main>', surface).match(
    /<script>\n([\s\S]*?)<\/script>/
  )?.[1]
  // Configurable only so happy-dom can tear down; the frame's copy stays locked.
  window.eval(script!.replaceAll('configurable: false', 'configurable: true'))
  const orca: FrameOrca = Object.getOwnPropertyDescriptor(window, 'orca')?.value
  const fromHost = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shim only compares source identity.
      new MessageEvent('message', { data, source: source as Window })
    )
  const posted = () => parent.postMessage.mock.calls.map(([message]) => message)
  return { orca, parent, fromHost, posted }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('window.orca', () => {
  it('times out a call the host never answers, and bounds calls in flight', async () => {
    vi.useFakeTimers()
    try {
      const { orca, posted } = mountShell()
      const lost = orca.host.call('workspace.readContext', {})
      const outcome = lost.then(
        () => 'resolved',
        (error: { code?: string }) => error.code
      )
      await vi.advanceTimersByTimeAsync(120_000)
      await expect(outcome).resolves.toBe('timeout')
      expect(posted().at(-1)).toMatchObject({ kind: 'cancel' })
      const flood = Array.from({ length: 256 }, () =>
        orca.host.call('workspace.readContext', {}).catch(() => undefined)
      )
      await expect(orca.host.call('workspace.readContext', {})).rejects.toMatchObject({
        code: 'rate_limited'
      })
      void flood
    } finally {
      vi.useRealTimers()
    }
  })

  it('is frozen, announces ready with the protocol, and knows api and methods up front', () => {
    const { orca, posted } = mountShell()
    expect(Object.isFrozen(orca)).toBe(true)
    expect(Object.isFrozen(orca.host)).toBe(true)
    expect(posted()).toEqual([{ orca: 1, kind: 'evt', event: 'ready', payload: { protocol: 1 } }])
    expect(orca.api).toEqual({ major: 1, minor: 2 })
    expect(orca.shell).toBeUndefined()
    expect(orca.files).toBeUndefined()
    expect(orca.host.has('shell.openExternal')).toBe(false)
    expect(orca.host.has('workspace.readContext')).toBe(true)
    expect(orca.host.has('terminal.sendText')).toBe(false)
    expect(orca.host.has('plugin.request')).toBe(true)
    expect(Object.isFrozen(orca.plugin)).toBe(true)
    expect(Object.isFrozen(orca.storage)).toBe(true)
    expect(orca.document).toBeUndefined()
  })

  it('takes api and methods from hello', () => {
    const { orca, fromHost } = mountShell()
    fromHost({
      orca: 1,
      kind: 'evt',
      event: 'hello',
      payload: { api: { major: 1, minor: 3 }, methods: ['future.method'], theme: null }
    })
    expect(orca.api).toEqual({ major: 1, minor: 3 })
    expect(orca.host.has('future.method')).toBe(true)
    expect(orca.host.has('workspace.readContext')).toBe(false)
  })

  it('resolves a call with its result and rejects with code, retryable and retryAfterMs', async () => {
    const { orca, fromHost, posted } = mountShell()
    const ok = orca.host.call('workspace.readContext', {})
    const limited = orca.host.call('notifications.show', { title: 'x' })
    const unknown = orca.host.call('notifications.show', { title: 'y' })
    expect(posted().slice(1)).toEqual([
      { orca: 1, kind: 'req', id: 0, method: 'workspace.readContext', params: {} },
      { orca: 1, kind: 'req', id: 1, method: 'notifications.show', params: { title: 'x' } },
      { orca: 1, kind: 'req', id: 2, method: 'notifications.show', params: { title: 'y' } }
    ])
    fromHost({ orca: 1, kind: 'res', id: 0, result: null })
    fromHost({
      orca: 1,
      kind: 'res',
      id: 1,
      error: { code: 'rate_limited', message: 'slow', retryable: true, retryAfterMs: 250 }
    })
    fromHost({ orca: 1, kind: 'res', id: 2, error: { code: 'from_the_future', message: 'x' } })
    await expect(ok).resolves.toBeNull()
    await expect(limited).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'slow',
      retryable: true,
      retryAfterMs: 250
    })
    await expect(unknown).rejects.toMatchObject({ code: 'action_failed', retryable: false })
  })

  it('ignores answers that do not come from the host window', async () => {
    const { orca, fromHost } = mountShell()
    const call = orca.host.call('workspace.readContext')
    fromHost({ orca: 1, kind: 'res', id: 0, result: 'spoofed' }, window)
    fromHost({ orca: 1, kind: 'res', id: 0, result: 'real' })
    await expect(call).resolves.toBe('real')
  })

  it('cancels through an AbortSignal: rejects at once and tells the host', async () => {
    const { orca, posted } = mountShell()
    const controller = new AbortController()
    const call = orca.host.call('workspace.readContext', {}, { signal: controller.signal })
    controller.abort()
    await expect(call).rejects.toMatchObject({ code: 'cancelled' })
    expect(posted().at(-1)).toEqual({ orca: 1, kind: 'cancel', id: 0 })
    await expect(
      orca.host.call('workspace.readContext', {}, { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('answers pings itself and delivers events to disposable listeners', () => {
    const { orca, fromHost, posted } = mountShell()
    fromHost({ orca: 1, kind: 'evt', event: 'ping', payload: 4 })
    expect(posted().at(-1)).toEqual({ orca: 1, kind: 'evt', event: 'pong', payload: 4 })
    const onTheme = vi.fn()
    const subscription = orca.on('theme', onTheme)
    fromHost({ orca: 1, kind: 'evt', event: 'theme', payload: { colorScheme: 'dark', tokens: '' } })
    subscription.dispose()
    fromHost({
      orca: 1,
      kind: 'evt',
      event: 'theme',
      payload: { colorScheme: 'light', tokens: '' }
    })
    expect(onTheme).toHaveBeenCalledTimes(1)
    expect(onTheme).toHaveBeenCalledWith({ colorScheme: 'dark' })
  })
})

describe('window.orca.document', () => {
  const doc = (version: number, text: string) => ({
    orca: 1,
    kind: 'evt',
    event: 'editor.document',
    payload: { version, readOnly: false, content: { kind: 'text', text } }
  })

  it('gets the latest document, reports changes and applies versioned edits', async () => {
    const { orca, fromHost, posted } = mountShell('editor')
    const document = orca.document!
    const first = document.get()
    fromHost(doc(1, 'a'))
    await expect(first).resolves.toMatchObject({ version: 1, content: { text: 'a' } })
    const changes = vi.fn()
    document.onDidChange(changes)
    // A late subscriber gets the document already in, then every later one.
    await flush()
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }))
    fromHost(doc(2, 'b'))
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ version: 2 }))
    expect(changes).toHaveBeenCalledTimes(2)
    await expect(document.get()).resolves.toMatchObject({ version: 2 })

    const applied = document.applyEdit({ baseVersion: 2, content: { kind: 'text', text: 'c' } })
    expect(posted().at(-1)).toEqual({
      orca: 1,
      kind: 'req',
      id: 0,
      method: 'editor.applyEdit',
      params: { baseVersion: 2, content: { kind: 'text', text: 'c' } }
    })
    fromHost({
      orca: 1,
      kind: 'res',
      id: 0,
      error: { code: 'conflict', message: 'stale', retryable: true }
    })
    await expect(applied).rejects.toMatchObject({ code: 'conflict', retryable: true })
  })

  it('awaits editor.flush handlers before answering the host', async () => {
    const { orca, fromHost, posted } = mountShell('editor')
    let finish!: () => void
    orca.on('editor.flush', () => new Promise<void>((resolve) => (finish = resolve)))
    fromHost({ orca: 1, kind: 'req', id: 7, method: 'editor.flush' })
    await flush()
    expect(posted().some((message) => message.kind === 'res')).toBe(false)
    finish()
    await flush()
    expect(posted().at(-1)).toEqual({ orca: 1, kind: 'res', id: 7, result: null })
  })

  it('forwards modifier chords for Orca shortcuts', () => {
    const { posted } = mountShell('editor')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true }))
    expect(posted().at(-1)).toMatchObject({
      kind: 'evt',
      event: 'editor.keydown',
      payload: { key: 's', code: 'KeyS', metaKey: true, ctrlKey: false }
    })
  })
})

/** The guest shell over a fake preload transport; `fromHost` delivers like ipcRenderer.on. */
function mountGuestShell(surface: PluginFrameSurface = 'panel') {
  Reflect.deleteProperty(window, 'orca')
  const send = vi.fn()
  let receive: (message: unknown) => void = () => {}
  Object.defineProperty(window, '__orcaPluginFrameTransport', {
    value: { send, subscribe: (fn: (message: unknown) => void) => (receive = fn) },
    configurable: true
  })
  const script =
    buildPluginGuestShellHtml('<main></main>', surface)
      .match(/<script>\n([\s\S]*?)<\/script>/)?.[1]
      ?.replaceAll('configurable: false', 'configurable: true') ?? ''
  window.eval(script)
  const orca: FrameOrca = Object.getOwnPropertyDescriptor(window, 'orca')?.value
  const posted = () => send.mock.calls.map(([message]) => message)
  return { orca, fromHost: (data: unknown) => receive(data), posted }
}

function setUserActivation(isActive: boolean | null): void {
  Object.defineProperty(navigator, 'userActivation', {
    value: isActive === null ? undefined : { isActive },
    configurable: true
  })
}

describe('window.orca user-gesture methods', () => {
  afterEach(() => setUserActivation(null))

  it('refuse without transient activation and never reach the host', async () => {
    const { orca, posted } = mountGuestShell()
    setUserActivation(false)
    await expect(orca.shell!.openExternal('https://example.com')).rejects.toMatchObject({
      code: 'not_permitted'
    })
    await expect(orca.files!.saveAs({ data: 'x' })).rejects.toMatchObject({ code: 'not_permitted' })
    expect(posted()).toHaveLength(1)
  })

  it('call the host with activation, sending bytes as an ArrayBuffer', () => {
    const { orca, posted } = mountGuestShell()
    setUserActivation(true)
    void orca.shell!.openExternal('https://example.com/docs')
    void orca.files!.saveAs({
      suggestedName: 'chart.png',
      mimeType: 'image/png',
      data: new Uint8Array([1, 2, 3]).subarray(1)
    })
    const [open, save] = posted().slice(1)
    expect(open).toMatchObject({
      kind: 'req',
      method: 'shell.openExternal',
      params: { url: 'https://example.com/docs' }
    })
    expect(save).toMatchObject({
      kind: 'req',
      method: 'files.saveAs',
      params: { suggestedName: 'chart.png', mimeType: 'image/png' }
    })
    expect(save.params.data).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(save.params.data)]).toEqual([2, 3])
  })
})

describe('window.orca saveAs and locale', () => {
  afterEach(() => setUserActivation(null))

  it('resolves a save and a cancelled dialog alike, with their status', async () => {
    const { orca, fromHost } = mountGuestShell()
    setUserActivation(true)
    const saved = orca.files!.saveAs({ data: 'a' })
    const cancelled = orca.files!.saveAs({ data: 'b' })
    fromHost({ orca: 1, kind: 'res', id: 0, result: { status: 'saved' } })
    fromHost({ orca: 1, kind: 'res', id: 1, result: { status: 'cancelled' } })
    await expect(saved).resolves.toEqual({ status: 'saved' })
    await expect(cancelled).resolves.toEqual({ status: 'cancelled' })
  })

  it("follows Orca's UI locale from hello, falling back to navigator.language", () => {
    const { orca, fromHost } = mountGuestShell()
    expect(orca.locale).toBe(navigator.language)
    fromHost({ orca: 1, kind: 'evt', event: 'hello', payload: { locale: 'de-DE', theme: null } })
    expect(orca.locale).toBe('de-DE')
  })
})

describe('guest window.orca', () => {
  const guestScript = (surface: PluginFrameSurface = 'panel') =>
    buildPluginGuestShellHtml('<main></main>', surface)
      .match(/<script>\n([\s\S]*?)<\/script>/)?.[1]
      ?.replaceAll('configurable: false', 'configurable: true') ?? ''

  it('takes the preload transport once, before plugin code can see it', async () => {
    Reflect.deleteProperty(window, 'orca')
    const send = vi.fn()
    let receive: ((message: unknown) => void) | null = null
    Object.defineProperty(window, '__orcaPluginFrameTransport', {
      value: { send, subscribe: (fn: (message: unknown) => void) => (receive = fn) },
      configurable: true
    })
    window.eval(guestScript())
    expect('__orcaPluginFrameTransport' in window).toBe(false)
    expect(send).toHaveBeenCalledWith({
      orca: 1,
      kind: 'evt',
      event: 'ready',
      payload: { protocol: 1 }
    })
    const orca: FrameOrca = Object.getOwnPropertyDescriptor(window, 'orca')?.value
    const answer = orca.host.call('workspace.readContext', {})
    receive!({ orca: 1, kind: 'res', id: 0, result: { ok: true } })
    await expect(answer).resolves.toEqual({ ok: true })
    // Window messages are not the guest channel.
    window.dispatchEvent(
      new MessageEvent('message', { data: { orca: 1, kind: 'evt', event: 'ping', payload: 1 } })
    )
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('defines no window.orca without the preload', () => {
    Reflect.deleteProperty(window, 'orca')
    window.eval(guestScript())
    expect('orca' in window).toBe(false)
  })
})

describe('hello-orca example panel', () => {
  it('talks to Orca only through window.orca', async () => {
    const html = readFileSync(
      join(process.cwd(), 'examples', 'plugins', 'hello-orca', 'panel.html'),
      'utf8'
    )
    expect(html).not.toContain('postMessage')
    document.body.innerHTML = html.match(/<body>([\s\S]*?)<script>/)?.[1] ?? ''
    const { fromHost, posted } = mountShell()
    window.eval(html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '')
    document.getElementById('ctx')!.click()
    expect(posted().at(-1)).toMatchObject({ kind: 'req', method: 'workspace.readContext' })
    fromHost({
      orca: 1,
      kind: 'res',
      id: 0,
      result: { branch: 'main', displayName: 'Repo', terminals: [{ id: 't' }] }
    })
    await flush()
    expect(document.getElementById('status')!.textContent).toBe('Repo on branch main · 1 terminal')
  })
})
