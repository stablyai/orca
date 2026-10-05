import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopBrowserViewApi,
  DesktopBrowserViewCreateArgs,
  DesktopBrowserViewEvent,
  DesktopBrowserViewIdentity,
  DesktopBrowserViewState
} from '../../../../../shared/desktop-browser-view-protocol'
import {
  claimDesktopBrowserPage,
  closeDesktopBrowserPage,
  ensureDesktopBrowserPage,
  hasDesktopBrowserPage
} from './desktop-browser-page-registry'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

let sequence = 0
const cleanup: string[] = []
function fixture() {
  const args: DesktopBrowserViewCreateArgs = {
    browserPageId: `persistent-native-${++sequence}`,
    workspaceId: 'workspace',
    worktreeId: 'folder',
    sessionProfileId: null,
    url: 'https://example.test/'
  }
  cleanup.push(args.browserPageId)
  let generation = 0
  let revision = 0
  const state = (): DesktopBrowserViewState => ({
    browserPageId: args.browserPageId,
    generation: String(generation),
    revision: ++revision,
    url: args.url,
    title: 'Page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    loadError: null,
    zoomLevel: 0,
    focused: false
  })
  const listeners = new Set<(event: DesktopBrowserViewEvent) => void>()
  const create = vi.fn(async (_args: DesktopBrowserViewCreateArgs) => {
    generation++
    return state()
  })
  const close = vi.fn(async (_identity: DesktopBrowserViewIdentity) => {})
  const updateLayout = vi.fn<DesktopBrowserViewApi['updateLayout']>(async () => {})
  const api: DesktopBrowserViewApi = {
    create,
    close,
    updateLayout,
    command: vi.fn(async () => ({ state: state() })),
    input: vi.fn(async () => {}),
    captureViewport: vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,AA==',
      width: 10,
      height: 10
    })),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  return {
    api,
    args,
    create,
    close,
    updateLayout,
    listeners,
    state,
    emit: (event: DesktopBrowserViewEvent) => {
      for (const listener of listeners) {
        listener(event)
      }
    }
  }
}

afterEach(async () => {
  for (const pageId of cleanup.splice(0)) {
    await closeDesktopBrowserPage(pageId)
  }
})

describe('persistent desktop browser page ownership', () => {
  it('deduplicates concurrent creation and reuses a parked page without navigating it again', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([
      ensureDesktopBrowserPage(f.api, f.args),
      ensureDesktopBrowserPage(f.api, f.args)
    ])
    expect(a).toBe(b)
    expect(
      await ensureDesktopBrowserPage(f.api, { ...f.args, url: 'https://redirect.test/' })
    ).toBe(a)
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.listeners.size).toBe(2)
    await closeDesktopBrowserPage(f.args.browserPageId)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.listeners.size).toBe(0)
    expect(hasDesktopBrowserPage(f.args.browserPageId)).toBe(false)
  })

  it('waits for exact old-generation close before creating a profile replacement', async () => {
    const f = fixture()
    const first = await ensureDesktopBrowserPage(f.api, f.args)
    const closed = deferred<void>()
    f.close.mockImplementationOnce(() => closed.promise)
    const replacement = ensureDesktopBrowserPage(f.api, { ...f.args, sessionProfileId: 'other' })
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce())
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.close).toHaveBeenCalledWith({
      browserPageId: f.args.browserPageId,
      generation: first.state.generation
    })
    closed.resolve()
    const next = await replacement
    expect(next.state.generation).not.toBe(first.state.generation)
    const title = next.state.title
    f.emit({ kind: 'state', state: { ...first.state, revision: 999, title: 'stale' } })
    expect(next.state.title).toBe(title)
  })

  it('settles a still-creating page before its close and retains failed close for retry', async () => {
    const f = fixture()
    const created = deferred<DesktopBrowserViewState>()
    f.create.mockImplementationOnce(() => created.promise)
    const open = ensureDesktopBrowserPage(f.api, f.args)
    const close = closeDesktopBrowserPage(f.args.browserPageId)
    await Promise.resolve()
    expect(f.close).not.toHaveBeenCalled()
    created.resolve(f.state())
    await open
    await close
    expect(f.close).toHaveBeenCalledOnce()
    await ensureDesktopBrowserPage(f.api, f.args)
    f.close.mockRejectedValueOnce(new Error('capture still retained'))
    await expect(closeDesktopBrowserPage(f.args.browserPageId)).rejects.toThrow(
      'capture still retained'
    )
    expect(hasDesktopBrowserPage(f.args.browserPageId)).toBe(true)
    await closeDesktopBrowserPage(f.args.browserPageId)
    expect(f.listeners.size).toBe(0)
  })

  it('does not let an old presenter hide a page claimed by its replacement', async () => {
    const f = fixture()
    const page = await ensureDesktopBrowserPage(f.api, f.args)
    page.layout = {
      browserPageId: f.args.browserPageId,
      generation: page.state.generation,
      bounds: { x: 10, y: 50, width: 800, height: 600 },
      visible: true,
      inputLocked: false
    }
    const old = claimDesktopBrowserPage(page)
    const next = claimDesktopBrowserPage(page)
    await old.release()
    expect(f.updateLayout).not.toHaveBeenCalled()
    await next.release()
    expect(f.updateLayout).toHaveBeenCalledWith({ ...page.layout, visible: false })
  })

  it('keeps document readiness and ignores stale generation document events', async () => {
    const f = fixture()
    const page = await ensureDesktopBrowserPage(f.api, f.args)
    const identity = { browserPageId: f.args.browserPageId, generation: page.state.generation }
    f.emit({ ...identity, kind: 'page-ready' })
    expect(page.ready).toBe(true)
    f.emit({
      ...identity,
      kind: 'navigation-start',
      url: 'https://next.test/',
      sameDocument: false
    })
    expect(page.ready).toBe(false)
    expect(page.documentRevision).toBe(1)
    f.emit({ ...identity, generation: 'stale', kind: 'page-ready' })
    expect(page.ready).toBe(false)
  })
})
