// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPluginPanelShellHtml, type PluginFrameSurface } from './plugin-panel-shell'

/** The injected `window.orca` is the public frame API; the envelope under it stays internal. */

type FrameOrca = {
  api: { major: number; minor: number }
  host: {
    call: (method: string, params?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
    has: (method: string) => boolean
  }
  on: (event: string, handler: (payload: unknown) => unknown) => { dispose: () => void }
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
  it('is frozen, announces ready with the protocol, and knows api and methods up front', () => {
    const { orca, posted } = mountShell()
    expect(Object.isFrozen(orca)).toBe(true)
    expect(Object.isFrozen(orca.host)).toBe(true)
    expect(posted()).toEqual([{ orca: 1, kind: 'evt', event: 'ready', payload: { protocol: 1 } }])
    expect(orca.api).toEqual({ major: 1, minor: 0 })
    expect(orca.host.has('workspace.readContext')).toBe(true)
    expect(orca.host.has('terminal.sendText')).toBe(false)
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
