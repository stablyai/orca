import type { WebglAddon } from '@xterm/addon-webgl'
import { createLazyXtermAddonLoader } from './terminal-lazy-addon-loader'

// Why this is deferred at all: nine boot-path modules import pane-webgl-renderer
// for ENABLE_WEBGL_RENDERER / disposeWebgl / presentPaneViewport…, which dragged
// the 243 KB addon into the chunk every renderer launch fetches and evaluates
// before first paint — even though it is only ever constructed once a terminal
// attaches. The load stays eager, just off the critical path: main.tsx primes it
// right after the React root renders, and attachWebgl reads the resolved
// constructor synchronously.
const loader = createLazyXtermAddonLoader<new () => WebglAddon>({
  load: () => import('@xterm/addon-webgl').then((module) => module.WebglAddon),
  failureMessage: '[terminal] WebGL addon failed to load — using DOM renderer:'
})

type TerminalWebglAddonLoadHandlers = {
  onLoaded: () => void
  onFailed: () => void
}

export function setTerminalWebglAddonLoadHandlers(next: TerminalWebglAddonLoadHandlers): void {
  loader.setHandlers(next)
}

export function getTerminalWebglAddonConstructor(): (new () => WebglAddon) | null {
  return loader.getConstructor()
}

export function primeTerminalWebglAddon(): Promise<void> {
  return loader.prime()
}

/** Recovery boundary (GPU setting changed): let a failed load try again. */
export function rearmTerminalWebglAddonLoad(): void {
  loader.rearm()
}
