import type { WebglAddon } from '@xterm/addon-webgl'

// Why this is deferred at all: nine boot-path modules import pane-webgl-renderer
// for ENABLE_WEBGL_RENDERER / disposeWebgl / presentPaneViewport…, which dragged
// the 243 KB addon into the chunk every renderer launch fetches and evaluates
// before first paint — even though it is only ever constructed once a terminal
// attaches. The load stays eager, just off the critical path: main.tsx primes it
// right after the React root renders, and attachWebgl reads the resolved
// constructor synchronously.
let webglAddonConstructor: (new () => WebglAddon) | null = null
let webglAddonLoad: Promise<void> | null = null
let webglAddonLoadAttempts = 0

// Why a cap rather than unlimited retries: a chunk that is genuinely gone (bad
// deploy, unreadable disk) must not re-fetch on every attach, but one transient
// failure must not strand every pane on the DOM renderer for the session either.
const WEBGL_ADDON_LOAD_ATTEMPT_LIMIT = 3

type TerminalWebglAddonLoadHandlers = {
  /** Attach the panes that opened while the load was still in flight. */
  onLoaded: () => void
  /** Latch those panes so they retry at a recovery boundary, not every frame. */
  onFailed: () => void
}

let handlers: TerminalWebglAddonLoadHandlers | null = null

export function setTerminalWebglAddonLoadHandlers(next: TerminalWebglAddonLoadHandlers): void {
  handlers = next
}

export function getTerminalWebglAddonConstructor(): (new () => WebglAddon) | null {
  return webglAddonConstructor
}

export function primeTerminalWebglAddon(): Promise<void> {
  if (webglAddonConstructor || webglAddonLoad) {
    return webglAddonLoad ?? Promise.resolve()
  }
  if (webglAddonLoadAttempts >= WEBGL_ADDON_LOAD_ATTEMPT_LIMIT) {
    return Promise.resolve()
  }
  webglAddonLoadAttempts += 1
  webglAddonLoad = import('@xterm/addon-webgl').then(
    (module) => {
      webglAddonConstructor = module.WebglAddon
      handlers?.onLoaded()
    },
    (error) => {
      // Why clear the memo: `.then(onOk, onError)` settles *fulfilled*, so
      // caching it would strand every pane on the DOM renderer for the rest of
      // the session — and the GPU-setting recovery path could not clear it.
      webglAddonLoad = null
      handlers?.onFailed()
      console.warn('[terminal] WebGL addon failed to load — using DOM renderer:', error)
    }
  )
  return webglAddonLoad
}

/** Recovery boundary (GPU setting changed): let a failed load try again. */
export function rearmTerminalWebglAddonLoad(): void {
  if (webglAddonConstructor) {
    return
  }
  webglAddonLoad = null
  webglAddonLoadAttempts = 0
}
