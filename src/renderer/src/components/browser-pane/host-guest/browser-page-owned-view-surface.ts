import type {
  DesktopBrowserViewApi,
  DesktopBrowserViewCommand,
  DesktopBrowserViewFindResult,
  DesktopBrowserViewState
} from '../../../../../shared/desktop-browser-view-protocol'
import type { BrowserPageZoomDirection } from '../../../../../shared/browser-page-zoom'
import {
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel
} from '../../../../../shared/browser-page-zoom'
import type {
  BrowserPageSurface,
  BrowserPageSurfaceBounds,
  BrowserPageSurfaceFindResult,
  BrowserPageSurfaceSnapshot,
  BrowserPageSurfaceViewportCapture
} from './browser-page-surface'

type OwnedViewBrowserPageSurfaceOptions = {
  api: DesktopBrowserViewApi
  initialState: DesktopBrowserViewState
  getBounds: () => BrowserPageSurfaceBounds | null
  onDestroyed?: () => void
  onError?: (error: unknown) => void
  onState?: (state: DesktopBrowserViewState) => void
}

type OwnedViewBrowserPageSurface = {
  dispose: () => void
  surface: BrowserPageSurface
}

function toSnapshot(state: DesktopBrowserViewState): BrowserPageSurfaceSnapshot {
  return {
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.loading,
    title: state.title,
    url: state.url,
    zoomLevel: normalizeBrowserPageZoomLevel(state.zoomLevel)
  }
}

function matchesState(
  expected: Pick<DesktopBrowserViewState, 'browserPageId' | 'generation'>,
  actual: Pick<DesktopBrowserViewState, 'browserPageId' | 'generation'>
): boolean {
  return (
    expected.browserPageId === actual.browserPageId && expected.generation === actual.generation
  )
}

/**
 * Adapts one already-created desktop-owned BrowserView to renderer chrome. It never creates,
 * lays out, or closes the native view; its caller owns that lifecycle.
 */
export function createOwnedViewBrowserPageSurface({
  api,
  initialState,
  getBounds,
  onDestroyed,
  onError,
  onState
}: OwnedViewBrowserPageSurfaceOptions): OwnedViewBrowserPageSurface {
  const identity = {
    browserPageId: initialState.browserPageId,
    generation: initialState.generation
  }
  let currentState = initialState
  let disposed = false
  let destroyed = false
  let activeFindRequestId: number | null = null
  let pendingFindResults: DesktopBrowserViewFindResult[] = []
  let findPending = false
  let findRequestGeneration = 0
  let zoomQueue: Promise<void> = Promise.resolve()
  const findListeners = new Set<(result: BrowserPageSurfaceFindResult) => void>()

  const isLive = (): boolean => !disposed && !destroyed
  const reportError = (error: unknown): void => {
    if (isLive()) {
      onError?.(error)
    }
  }
  const acceptState = (next: DesktopBrowserViewState): boolean => {
    if (!isLive() || !matchesState(identity, next) || next.revision <= currentState.revision) {
      return false
    }
    currentState = next
    onState?.(next)
    return true
  }
  const emitFindResult = (result: DesktopBrowserViewFindResult): void => {
    if (!isLive() || result.requestId !== activeFindRequestId) {
      return
    }
    for (const listener of findListeners) {
      listener({ activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches })
    }
  }
  let unsubscribeEvents: () => void = () => {}
  unsubscribeEvents = api.onEvent((event) => {
    if (!isLive()) {
      return
    }
    if (event.kind === 'state') {
      acceptState(event.state)
      return
    }
    if (!matchesState(identity, event)) {
      return
    }
    if (event.kind === 'destroyed') {
      destroyed = true
      disposed = true
      pendingFindResults = []
      findListeners.clear()
      unsubscribeEvents()
      onDestroyed?.()
      return
    }
    if (event.kind !== 'found-in-page') {
      return
    }
    if (findPending) {
      pendingFindResults.push(event.result)
      return
    }
    emitFindResult(event.result)
  })

  const command = async (commandValue: DesktopBrowserViewCommand) => {
    if (!isLive()) {
      return null
    }
    try {
      const result = await api.command({ ...identity, command: commandValue })
      if (!isLive() || !matchesState(identity, result.state)) {
        return null
      }
      acceptState(result.state)
      // A reply may be older than a state event already accepted while IPC was in flight.
      // Keep the response metadata (such as findRequestId) but use the monotonic local state.
      return { ...result, state: currentState }
    } catch (error) {
      reportError(error)
      throw error
    }
  }
  const enqueueZoom = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = zoomQueue.then(operation, operation)
    zoomQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
  const readFreshZoomLevel = async (): Promise<number | null> => {
    const result = await command({ kind: 'snapshot' })
    return result ? result.state.zoomLevel : null
  }

  const surface: BrowserPageSurface = {
    blur: async () => {
      await command({ kind: 'blur' })
    },
    focus: async () => {
      const result = await command({ kind: 'focus' })
      return result?.state.focused ?? false
    },
    captureViewport: async (): Promise<BrowserPageSurfaceViewportCapture | null> => {
      if (!isLive()) {
        return null
      }
      try {
        const capture = await api.captureViewport(identity)
        return isLive() ? capture : null
      } catch (error) {
        reportError(error)
        throw error
      }
    },
    getBounds: () => (isLive() ? getBounds() : null),
    getSnapshot: () => (isLive() ? toSnapshot(currentState) : null),
    goBack: async () => {
      await command({ kind: 'back' })
    },
    goForward: async () => {
      await command({ kind: 'forward' })
    },
    isAttached: isLive,
    navigate: async (url) => {
      await command({ kind: 'navigate', url })
    },
    refresh: () => {
      void command({ kind: 'snapshot' }).catch(() => {
        // Why: refresh has no caller to observe an IPC failure; command already reported it while live.
      })
    },
    reload: async (ignoreCache) => {
      await command({ kind: 'reload', ignoreCache })
    },
    runFind: async (text, options) => {
      if (!text || !isLive()) {
        return
      }
      const requestGeneration = ++findRequestGeneration
      activeFindRequestId = null
      findPending = true
      pendingFindResults = []
      try {
        const result = await command({
          kind: 'find',
          text,
          forward: options?.forward ?? true,
          findNext: options?.findNext ?? false,
          matchCase: options?.matchCase ?? false
        })
        if (
          !isLive() ||
          requestGeneration !== findRequestGeneration ||
          typeof result?.findRequestId !== 'number'
        ) {
          return
        }
        activeFindRequestId = result.findRequestId
        for (const pending of pendingFindResults) {
          emitFindResult(pending)
        }
      } finally {
        if (requestGeneration === findRequestGeneration) {
          pendingFindResults = []
          findPending = false
        }
      }
    },
    setZoomLevel: (level) =>
      enqueueZoom(async () => {
        if (!isLive()) {
          return null
        }
        const next = normalizeBrowserPageZoomLevel(level)
        const currentZoom = await readFreshZoomLevel()
        if (currentZoom === null || !isLive()) {
          return null
        }
        if (normalizeBrowserPageZoomLevel(currentZoom) !== next) {
          const result = await command({ kind: 'zoom', level: next })
          if (!result || !isLive()) {
            return null
          }
        }
        return isLive() ? next : null
      }),
    stepZoom: (direction: BrowserPageZoomDirection, resetLevel) =>
      enqueueZoom(async () => {
        if (!isLive()) {
          return null
        }
        const currentZoom = await readFreshZoomLevel()
        if (currentZoom === null || !isLive()) {
          return null
        }
        const next = nextBrowserPageZoomLevel(currentZoom, direction, resetLevel)
        const result = await command({ kind: 'zoom', level: next })
        return result && isLive() ? next : null
      }),
    stop: async () => {
      await command({ kind: 'stop' })
    },
    stopFind: async (action = 'clearSelection') => {
      findRequestGeneration += 1
      activeFindRequestId = null
      pendingFindResults = []
      findPending = false
      await command({ kind: 'stop-find', action })
    },
    subscribeFindResults: (listener) => {
      if (isLive()) {
        findListeners.add(listener)
      }
      return () => findListeners.delete(listener)
    }
  }

  return {
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      pendingFindResults = []
      findListeners.clear()
      unsubscribeEvents()
    },
    surface
  }
}
