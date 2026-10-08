import type {
  DesktopBrowserViewApi,
  DesktopBrowserViewCreateArgs,
  DesktopBrowserViewEvent,
  DesktopBrowserViewLayout,
  DesktopBrowserViewState
} from '../../../../../shared/desktop-browser-view-protocol'
import type { BrowserPageSurfaceBounds } from './browser-page-surface'
import { createOwnedViewBrowserPageSurface } from './browser-page-owned-view-surface'

type PageListener = (event: DesktopBrowserViewEvent) => void

export type DesktopBrowserPage = {
  api: DesktopBrowserViewApi
  args: DesktopBrowserViewCreateArgs
  state: DesktopBrowserViewState
  surface: ReturnType<typeof createOwnedViewBrowserPageSurface>['surface']
  getBounds: () => BrowserPageSurfaceBounds | null
  subscribe: (listener: PageListener) => () => void
  dispose: () => void
  destroyed: boolean
  ready: boolean
  documentRevision: number
  presenter: symbol | null
  layout: DesktopBrowserViewLayout | null
}

const pages = new Map<string, DesktopBrowserPage>()
const lifecycle = new Map<string, Promise<void>>()

function serialize<T>(pageId: string, operation: () => Promise<T>): Promise<T> {
  const result = (lifecycle.get(pageId) ?? Promise.resolve()).then(operation)
  const settled = result.then(
    () => {},
    () => {}
  )
  lifecycle.set(pageId, settled)
  return result.finally(() => {
    if (lifecycle.get(pageId) === settled) {
      lifecycle.delete(pageId)
    }
  })
}

async function retire(page: DesktopBrowserPage): Promise<void> {
  if (!page.destroyed) {
    try {
      await page.api.close({
        browserPageId: page.state.browserPageId,
        generation: page.state.generation
      })
    } catch (error) {
      if (!page.destroyed) {
        throw error
      }
    }
  }
  page.dispose()
  if (pages.get(page.args.browserPageId) === page) {
    pages.delete(page.args.browserPageId)
  }
}

export function ensureDesktopBrowserPage(
  api: DesktopBrowserViewApi,
  args: DesktopBrowserViewCreateArgs
): Promise<DesktopBrowserPage> {
  return serialize(args.browserPageId, async () => {
    const previous = pages.get(args.browserPageId)
    if (previous) {
      if (
        !previous.destroyed &&
        previous.api === api &&
        previous.args.workspaceId === args.workspaceId &&
        previous.args.worktreeId === args.worktreeId &&
        previous.args.sessionProfileId === args.sessionProfileId
      ) {
        return previous
      }
      await retire(previous)
    }
    // Subscribe before create: navigation events can arrive before the IPC response.
    const pending: DesktopBrowserViewEvent[] = []
    let active: ((event: DesktopBrowserViewEvent) => void) | null = null
    const unsubscribe = api.onEvent((event) => {
      const pageId = event.kind === 'state' ? event.state.browserPageId : event.browserPageId
      if (pageId !== args.browserPageId) {
        return
      }
      if (active) {
        active(event)
      } else {
        pending.push(event)
      }
    })
    try {
      let initial = await api.create(args)
      for (const event of pending) {
        if (
          event.kind === 'state' &&
          event.state.generation === initial.generation &&
          event.state.revision > initial.revision
        ) {
          initial = event.state
        }
      }
      const listeners = new Set<PageListener>()
      const adapter = createOwnedViewBrowserPageSurface({
        api,
        initialState: initial,
        getBounds: () => page.getBounds(),
        onState: (state) => {
          page.state = state
        },
        onDestroyed: () => {
          page.destroyed = true
        }
      })
      const page: DesktopBrowserPage = {
        api,
        args,
        state: initial,
        surface: adapter.surface,
        getBounds: () => null,
        destroyed: false,
        ready: false,
        documentRevision: 0,
        presenter: null,
        layout: null,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        dispose: () => {
          adapter.dispose()
          unsubscribe()
          listeners.clear()
        }
      }
      active = (event) => {
        const identity = event.kind === 'state' ? event.state : event
        if (identity.generation !== page.state.generation) {
          return
        }
        if (event.kind === 'state' && event.state.revision > page.state.revision) {
          page.state = event.state
        }
        if (event.kind === 'destroyed') {
          page.destroyed = true
          adapter.dispose()
        }
        if (event.kind === 'page-ready') {
          page.ready = true
        }
        if (event.kind === 'renderer-gone') {
          page.ready = false
        }
        if (event.kind === 'navigation-start') {
          page.documentRevision++
          if (!event.sameDocument) {
            page.ready = false
          }
        }
        for (const listener of listeners) {
          listener(event)
        }
      }
      pages.set(args.browserPageId, page)
      for (const event of pending) {
        active(event)
      }
      page.surface.refresh()
      return page
    } catch (error) {
      unsubscribe()
      throw error
    }
  })
}

export function closeDesktopBrowserPage(pageId: string): Promise<void> {
  return serialize(pageId, async () => {
    const page = pages.get(pageId)
    if (page) {
      await retire(page)
    }
  })
}

export function hasDesktopBrowserPage(pageId: string): boolean {
  return pages.has(pageId) || lifecycle.has(pageId)
}

export function claimDesktopBrowserPage(page: DesktopBrowserPage): {
  isCurrent: () => boolean
  release: () => Promise<void>
} {
  const token = Symbol(page.args.browserPageId)
  page.presenter = token
  const isCurrent = (): boolean => page.presenter === token && !page.destroyed
  return {
    isCurrent,
    release: async () => {
      if (!isCurrent()) {
        return
      }
      page.presenter = null
      page.getBounds = () => null
      if (page.layout) {
        const hidden = { ...page.layout, visible: false, forwardInput: false }
        page.layout = hidden
        await page.api.updateLayout(hidden)
      }
    }
  }
}
